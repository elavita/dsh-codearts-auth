import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { runLoginFlow } from './login.js'
import { RefreshScheduler } from './refresh.js'
import type { CodeArtsCredential, LoginFlowOptions, LoginFlowResult } from './types.js'

/** CodeArts 登录结果存储所用的凭据引用。 */
export const CODEARTS_CREDENTIAL_REF = 'CODEARTS_ACCESS_TOKEN'

/** 一次成功登录的结果。 */
export interface LoginResult {
  /** 已存储的凭据值（原始令牌或 JSON 凭据字符串）。 */
  access: string
  /** 凭据过期的毫秒时间戳。 */
  expires: number
  /** 凭据值存储所用的凭据引用。 */
  ref: CredentialRef
  /** 打开的登录 URL。 */
  loginUrl: string
}

/** 用于配置界面的只读登录状态。 */
export interface LoginStatus {
  configured: boolean
  source?: string
  expiresAt?: number
  /** 存储的凭据是否可通过重新执行登录流程来续期。 */
  refreshable: boolean
  /** 最近一次刷新失败的原因（如有）。 */
  refreshError?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    codeartsAuth: CodeArtsAuth
  }
}

/** CodeArts 浏览器登录服务：运行 ticket 流程、持久化存储，并在过期前重新登录。 */
export class CodeArtsAuth extends Service {
  private readonly scheduler = new RefreshScheduler(
    () => this.refresh().catch(() => {}),
    (error) => { this.lastRefreshError = error instanceof Error ? error.message : String(error) },
  )
  private lastRefreshError: string | undefined

  constructor(ctx: Context) {
    super(ctx, 'codeartsAuth')
  }

  /** 运行登录流程并持久化存储所得凭据。 */
  async login(options?: LoginFlowOptions): Promise<LoginResult> {
    const ref = credentialRef(CODEARTS_CREDENTIAL_REF)
    const flow: LoginFlowResult = await runLoginFlow(options)
    await this.ctx.credentials.set(ref, flow.access)
    this.lastRefreshError = undefined
    this.scheduleRefresh()
    return { access: flow.access, expires: flow.expires, ref, loginUrl: flow.loginUrl }
  }

  /** 报告凭据是否已配置、过期时间以及是否可刷新。 */
  async status(): Promise<LoginStatus> {
    const ref = credentialRef(CODEARTS_CREDENTIAL_REF)
    const info = await this.ctx.credentials.describe(ref)
    if (!info.configured) return { configured: false, refreshable: false }
    let expiresAt: number | undefined
    const resolved = await this.ctx.credentials.resolve(ref)
    if (resolved) {
      try {
        const parsed = JSON.parse(resolved.value) as CodeArtsCredential
        if (parsed.expires_at) {
          const parsedDate = Date.parse(parsed.expires_at)
          if (!Number.isNaN(parsedDate)) expiresAt = parsedDate
        }
      } catch {
        /* 原始令牌凭据不携带过期元数据 */
      }
    }
    return {
      configured: true,
      source: info.source,
      expiresAt,
      refreshable: true,
      ...this.lastRefreshError === undefined ? {} : { refreshError: this.lastRefreshError },
    }
  }

  /**
   * 通过重新执行浏览器登录流程来续期凭据。旧版
   * ticket 流程签发的短时凭据不含刷新令牌，因此
   * 续期意味着重新登录（用户需在浏览器中再次授权）；
   * 调度器会在过期前不久触发此方法。
   */
  async refresh(): Promise<void> {
    const ref = credentialRef(CODEARTS_CREDENTIAL_REF)
    const flow: LoginFlowResult = await runLoginFlow({ fetcher: this.fetchImpl })
    await this.ctx.credentials.set(ref, flow.access)
    this.lastRefreshError = undefined
    this.scheduleRefresh()
  }

  /** 移除已存储的凭据并停止任何待处理的刷新。 */
  async logout(): Promise<void> {
    this.scheduler.stop()
    await this.ctx.credentials.unset(credentialRef(CODEARTS_CREDENTIAL_REF))
  }

  /** 用于测试的可注入 fetch；默认为全局 fetch。 */
  private fetchImpl: typeof fetch = fetch

  private scheduleRefresh(): void {
    void this.ctx.credentials.resolve(credentialRef(CODEARTS_CREDENTIAL_REF)).then((resolved) => {
      if (!resolved) return
      try {
        const credential = JSON.parse(resolved.value) as CodeArtsCredential
        const expiresAt = Date.parse(credential.expires_at)
        if (!Number.isNaN(expiresAt)) this.scheduler.arm(expiresAt)
      } catch {
        /* 不可刷新；忽略 */
      }
    })
  }
}
