/**
 * Buddy (腾讯 CodeBuddy) 认证服务
 *
 * 管理 external-link-v2 轮询式登录、凭据存储与 RefreshScheduler 静默续期，
 * 结构与 CodeArtsAuth 保持一致（同样的调度语义、同样的登出竞态保护）。
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  credentialExpiresAtMs,
  isExpired,
  isRefreshable,
} from './buddy.js'
import {
  RefreshTokenExpiredError,
  fetchModels,
  refreshToken,
  runBuddyLoginFlow,
  type BuddyLoginFlowOptions,
} from './buddy-oauth.js'
import { RefreshScheduler } from './refresh.js'
import type { BuddyCredential } from './buddy.js'

/** Buddy 登录结果存储所用的凭据引用。 */
export const BUDDY_CREDENTIAL_REF = 'BUDDY_ACCESS_TOKEN'

/** 一次成功登录的结果。 */
export interface BuddyLoginResult {
  /** 已存储的凭据 JSON 字符串。 */
  access: string
  /** 凭据过期的毫秒时间戳（无法解析时为 0）。 */
  expires: number
  /** 凭据值存储所用的凭据引用。 */
  ref: CredentialRef
  /** 打开的登录 URL。 */
  loginUrl: string
  /** 凭据是否携带 refresh_token。 */
  refreshable: boolean
}

/** 用于配置界面的只读登录状态。 */
export interface BuddyLoginStatus {
  configured: boolean
  source?: string
  expiresAt?: number
  /** 存储的凭据是否可通过刷新令牌静默续期。 */
  refreshable: boolean
  /** 最近一次刷新失败的原因（如有）。 */
  refreshError?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    buddyAuth: BuddyAuth
  }
}

/** 从存储值解析凭据 JSON；解析失败返回 undefined。 */
function parseCredential(value: string): BuddyCredential | undefined {
  try {
    const parsed = JSON.parse(value) as BuddyCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/** Buddy 登录服务：轮询式登录 + refresh_token 静默续期。 */
export class BuddyAuth extends Service {
  private readonly scheduler = new RefreshScheduler(
    () => this.refresh(),
    (error) => {
      if (error instanceof RefreshTokenExpiredError) {
        // 失效：停止重试，并向 status() 暴露 refreshable: false 与重新登录提示。
        this.markRefreshTokenInvalid()
        return
      }
      this.lastRefreshError = error instanceof Error ? error.message : String(error)
    },
  )
  /** refresh_token 已被后端判定失效；登录/刷新成功时重置。 */
  private refreshTokenInvalid = false
  private lastRefreshError: string | undefined
  /** 登录会话是否仍处于活跃状态；logout()/stop() 置 false，防止在途刷新回写已登出凭据。 */
  private active = true

  constructor(ctx: Context, private readonly options: { fetcher?: typeof fetch } = {}) {
    super(ctx, 'buddyAuth')
  }

  /** 标记 refresh_token 已失效：停止重试，并向 status() 暴露 refreshable: false 与重新登录提示。 */
  private markRefreshTokenInvalid(): void {
    this.refreshTokenInvalid = true
    this.lastRefreshError = 'refresh_token 已失效，请重新登录'
  }

  /** 运行登录流程并持久化凭据。 */
  async login(flowOptions: BuddyLoginFlowOptions = {}): Promise<BuddyLoginResult> {
    this.active = true
    const ref = credentialRef(BUDDY_CREDENTIAL_REF)
    const flow = await runBuddyLoginFlow({
      ...this.options.fetcher !== undefined ? { fetcher: this.options.fetcher } : {},
      ...flowOptions,
    })
    await this.ctx.credentials.set(ref, flow.access)
    this.refreshTokenInvalid = false
    this.lastRefreshError = undefined
    this.scheduleRefresh()
    const credential = parseCredential(flow.access)
    return {
      access: flow.access,
      expires: flow.expires,
      ref,
      loginUrl: flow.loginUrl,
      refreshable: Boolean(credential) && isRefreshable(credential!),
    }
  }

  /** 报告凭据是否已配置、过期时间、是否可刷新以及最近刷新错误。 */
  async status(): Promise<BuddyLoginStatus> {
    const ref = credentialRef(BUDDY_CREDENTIAL_REF)
    const info = await this.ctx.credentials.describe(ref)
    if (!info.configured) return { configured: false, refreshable: false }
    let expiresAt: number | undefined
    let refreshable = false
    const resolved = await this.ctx.credentials.resolve(ref)
    if (resolved) {
      const credential = parseCredential(resolved.value)
      if (credential) {
        expiresAt = credentialExpiresAtMs(credential)
        refreshable = isRefreshable(credential) && !this.refreshTokenInvalid
      }
    }
    return {
      configured: true,
      source: info.source,
      expiresAt,
      refreshable,
      ...this.lastRefreshError === undefined ? {} : { refreshError: this.lastRefreshError },
    }
  }

  /** 静默续期：refresh_token 换取；无 refresh_token 时明确报错（由命令提示重新登录）。 */
  async refresh(): Promise<void> {
    const ref = credentialRef(BUDDY_CREDENTIAL_REF)
    const resolved = await this.ctx.credentials.resolve(ref)
    if (!resolved) throw new Error('未配置凭据，请先登录')
    const credential = parseCredential(resolved.value)
    if (!credential) throw new Error('凭据解析失败')
    if (!isRefreshable(credential)) {
      throw new RefreshTokenExpiredError('无 refresh_token，请重新登录')
    }
    try {
      const token = await refreshToken(credential, this.fetchImpl)
      // 登出竞态保护：在途刷新期间已 logout()/stop() 时，跳过凭据回写与调度武装，
      // 避免已登出的凭据被在途刷新复活。
      if (!this.active) return
      const refreshed: BuddyCredential = {
        ...credential,
        access_token: token.accessToken,
        refresh_token: token.refreshToken,
        expires_at: token.expiresAt,
        refresh_expires_at: token.refreshExpiresAt,
        token_type: token.tokenType,
        scope: token.scope,
        // 后端未返回 domain 时保留原值。
        ...token.domain.length > 0 ? { domain: token.domain } : {},
      }
      await this.ctx.credentials.set(ref, JSON.stringify(refreshed))
      this.refreshTokenInvalid = false
      this.lastRefreshError = undefined
      this.scheduleRefresh()
    } catch (error) {
      // 手动 refresh()（或 llm-adapter 触发）遇 refresh_token 失效同样更新状态，
      // 供 /buddy-status 展示 refreshable: false 与重新登录提示。
      if (error instanceof RefreshTokenExpiredError) this.markRefreshTokenInvalid()
      throw error
    }
  }

  /** 移除已存储的凭据并停止任何待处理的刷新。 */
  async logout(): Promise<void> {
    // 先置 inactive，再清凭据：在途刷新完成后不得回写/重新武装调度。
    this.active = false
    this.scheduler.stop()
    await this.ctx.credentials.unset(credentialRef(BUDDY_CREDENTIAL_REF))
  }

  /** 停止刷新调度（不清理凭据）。 */
  stop(): void {
    this.active = false
    this.scheduler.stop()
  }

  /** 启动时若已有可刷新凭据则安排续期（由 apply 调用）。 */
  scheduleRefresh(): void {
    void this.ctx.credentials.resolve(credentialRef(BUDDY_CREDENTIAL_REF)).then((resolved) => {
      if (!resolved) return
      const credential = parseCredential(resolved.value)
      if (!credential || !isRefreshable(credential)) return
      const expiresAt = credentialExpiresAtMs(credential)
      if (expiresAt !== undefined) this.scheduler.arm(expiresAt)
    })
  }

  /** 从存储重载凭据，返回是否已过期（供 UI 判断是否需要提示重新登录）。 */
  async checkExpired(): Promise<boolean> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(BUDDY_CREDENTIAL_REF))
    if (!resolved) return true
    const credential = parseCredential(resolved.value)
    return credential === undefined ? true : isExpired(credential)
  }

  /**
   * GET /v3/config → 获取远端模型列表（craft agent 的 models）。
   * 失败或未登录时返回空数组（调用方回退到内置列表）。
   */
  async fetchModels(): Promise<Array<{ id: string; name: string; contextWindow?: number }>> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(BUDDY_CREDENTIAL_REF))
    if (!resolved) return []
    const credential = parseCredential(resolved.value)
    if (!credential) return []
    return fetchModels(credential, this.fetchImpl)
  }

  /** 注入的 fetch（测试用）；默认为全局 fetch。 */
  private get fetchImpl(): typeof fetch {
    return this.options.fetcher ?? fetch
  }
}
