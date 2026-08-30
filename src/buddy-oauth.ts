/**
 * 腾讯 CodeBuddy 认证网络流程（external-link-v2 轮询式）
 *
 * 对齐 IDE genie 扩展的 NativeAuthBridgeService，流程为
 * fetchAuthState → 打开浏览器 → 轮询 token → 轮询 account，
 * 另有 refreshToken 静默续期与 fetchModels 远端模型拉取。
 *
 * 所有网络调用都接受注入的 fetcher，便于测试与复用；浏览器打开器同理。
 */

import {
  API_DOMAIN,
  API_ENDPOINT,
  AUTH_REFRESH_SOURCE,
  AUTH_REFRESH_PATH,
  AUTH_STATE_PATH,
  AUTH_TOKEN_PATH,
  BUDDY_DEPLOYMENT_TYPE,
  BUDDY_PRODUCT_CODE,
  BUDDY_USER_AGENT,
  CODE_ACCOUNT_NOT_READY,
  CODE_TOKEN_NOT_READY,
  CONFIG_PATH,
  HTTP_HEADER_AUTH_REFRESH_SOURCE,
  HTTP_HEADER_DOMAIN,
  HTTP_HEADER_NO_AUTHORIZATION,
  HTTP_HEADER_NO_DEPARTMENT_INFO,
  HTTP_HEADER_NO_ENTERPRISE_ID,
  HTTP_HEADER_NO_USER_ID,
  HTTP_HEADER_PRODUCT,
  HTTP_HEADER_PRODUCT_CODE,
  HTTP_HEADER_REFRESH_TOKEN,
  LOGIN_ACCOUNT_PATH,
  LOGIN_TIMEOUT_MS,
  PLATFORM,
  POLL_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  STATE_REQUEST_TIMEOUT_MS,
  buildCredential,
  credentialAuthHeaders,
  credentialExpiresAtMs,
  credentialRequestHeaders,
  isRefreshable,
  parseAccountData,
  parseModelsFromConfig,
  parseTokenData,
} from './buddy.js'
import type { BuddyAccount, BuddyCredential, BuddyToken } from './buddy.js'

/** 在浏览器中打开登录 URL；永不抛出（失败时打印 URL 供手动打开）。 */
export type OpenBrowser = (url: string) => void

/** 一次登录流程的结果。 */
export interface BuddyLoginFlowResult {
  /** 已序列化的 BuddyCredential JSON。 */
  access: string
  /** 凭据过期的毫秒时间戳（无法解析时为 0）。 */
  expires: number
  /** 展示给用户的登录 URL。 */
  loginUrl: string
  /** 凭据是否携带 refresh_token。 */
  refreshable: boolean
}

/** runBuddyLoginFlow 接受的选项。 */
export interface BuddyLoginFlowOptions {
  /** 使用的 fetch 实现；默认为全局 fetch。 */
  fetcher?: typeof fetch
  /** 在浏览器中打开登录 URL；默认使用平台打开器。 */
  openBrowser?: OpenBrowser
  /** 轮询总超时（毫秒）；默认为 5 分钟。 */
  timeoutMs?: number
  /** 轮询间隔（毫秒）；默认为 1 秒。 */
  pollIntervalMs?: number
}

/** 从 JSON 响应体读取错误码。 */
function responseCode(body: unknown): number {
  if (typeof body !== 'object' || body === null) return 0
  const code = (body as Record<string, unknown>).code
  return typeof code === 'number' ? code : 0
}

/** 从 JSON 响应体读取 message 字段。 */
function responseMessage(body: unknown): string {
  if (typeof body !== 'object' || body === null) return ''
  const message = (body as Record<string, unknown>).message
  return typeof message === 'string' ? message : ''
}

/** 从 JSON 响应体读取 data 字段（null/undefined 视为缺失）。 */
function responseData(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return undefined
  const data = (body as Record<string, unknown>).data
  return data === null ? undefined : data
}

/** request() 的调用选项。 */
interface RequestOptions {
  fetcher: typeof fetch
  /** 请求超时（毫秒）。 */
  timeoutMs: number
  /** 外部取消信号；与自身超时任一触发即中止。 */
  signal?: AbortSignal
}

/** 发起一次 CodeBuddy 控制面请求，返回 (status, body)。网络失败会抛出。 */
async function request(
  method: 'GET' | 'POST',
  url: string,
  headers: Record<string, string>,
  options: RequestOptions,
): Promise<{ status: number; body: unknown }> {
  const signal = options.signal === undefined
    ? AbortSignal.timeout(options.timeoutMs)
    : AbortSignal.any([AbortSignal.timeout(options.timeoutMs), options.signal])
  let response: Response
  try {
    response = await options.fetcher(url, { method, headers, signal })
  } catch (error) {
    throw new Error(`CodeBuddy ${method} ${url} network error: ${String(error)}`)
  }
  let body: unknown = null
  try {
    body = (await response.json()) as unknown
  } catch {
    body = null
  }
  return { status: response.status, body }
}

/**
 * POST /v2/plugin/auth/state?platform=ide → 获取 state + authUrl（无需认证）。
 */
export async function fetchAuthState(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<{ state: string; authUrl: string }> {
  const url = `${API_ENDPOINT}${AUTH_STATE_PATH}?platform=${PLATFORM}`
  const headers: Record<string, string> = {
    [HTTP_HEADER_DOMAIN]: API_DOMAIN,
    [HTTP_HEADER_NO_AUTHORIZATION]: 'true',
    [HTTP_HEADER_NO_USER_ID]: 'true',
    [HTTP_HEADER_NO_ENTERPRISE_ID]: 'true',
    [HTTP_HEADER_NO_DEPARTMENT_INFO]: 'true',
    'User-Agent': BUDDY_USER_AGENT,
  }
  const { status, body } = await request('POST', url, headers, {
    fetcher, timeoutMs: STATE_REQUEST_TIMEOUT_MS, ...signal !== undefined ? { signal } : {},
  })
  if (status !== 200) {
    throw new Error(`auth/state HTTP ${status}: ${responseMessage(body)}`)
  }
  const data = responseData(body)
  if (typeof data !== 'object' || data === null) {
    throw new Error(`auth/state 响应缺少 data 字段: ${JSON.stringify(body)}`)
  }
  const record = data as Record<string, unknown>
  const state = typeof record.state === 'string' ? record.state : ''
  const authUrl = typeof record.authUrl === 'string' ? record.authUrl : ''
  if (state.length === 0) throw new Error('auth/state 响应缺少 state 字段')
  if (authUrl.length === 0) throw new Error('auth/state 响应缺少 authUrl 字段')
  return { state, authUrl }
}

/**
 * GET /v2/plugin/auth/token?state=... 轮询获取 token。
 *
 * 错误码 11217 = token 尚未就绪 → 继续轮询；网络错误同样继续轮询，
 * 不中断登录流程（对齐 Rust loop_get_token）。
 */
export async function loopGetToken(
  state: string,
  options: { fetcher?: typeof fetch; timeoutMs?: number; pollIntervalMs?: number; signal?: AbortSignal } = {},
): Promise<BuddyToken> {
  const fetcher = options.fetcher ?? fetch
  const url = `${API_ENDPOINT}${AUTH_TOKEN_PATH}?state=${encodeURIComponent(state)}`
  const headers: Record<string, string> = {
    [HTTP_HEADER_NO_AUTHORIZATION]: 'true',
    'User-Agent': BUDDY_USER_AGENT,
  }
  const deadline = Date.now() + (options.timeoutMs ?? LOGIN_TIMEOUT_MS)
  const interval = options.pollIntervalMs ?? POLL_INTERVAL_MS
  for (;;) {
    if (Date.now() >= deadline) throw new Error('获取 token 超时（5 分钟）')
    if (options.signal?.aborted) throw new Error('登录已取消')
    await sleep(interval)
    let result: { status: number; body: unknown }
    try {
      result = await request('GET', url, headers, {
        fetcher, timeoutMs: REQUEST_TIMEOUT_MS, ...options.signal !== undefined ? { signal: options.signal } : {},
      })
    } catch {
      // 网络错误：继续轮询（不中断登录流程）
      continue
    }
    const { status, body } = result
    if (status === 200) {
      const data = responseData(body)
      if (data !== undefined) return parseTokenData(data)
      // data 为 null，继续轮询
      continue
    }
    const code = responseCode(body)
    if (code === CODE_TOKEN_NOT_READY) continue
    throw new Error(`auth/token HTTP ${status} code=${code}: ${responseMessage(body)}`)
  }
}

/**
 * GET /v2/plugin/login/account?state=... 轮询获取账户信息（需 Bearer token）。
 *
 * 错误码 12151 = 账户信息尚未完成 → 继续轮询。
 */
export async function getAccount(
  state: string,
  token: BuddyToken,
  options: { fetcher?: typeof fetch; timeoutMs?: number; pollIntervalMs?: number; signal?: AbortSignal } = {},
): Promise<BuddyAccount> {
  const fetcher = options.fetcher ?? fetch
  const url = `${API_ENDPOINT}${LOGIN_ACCOUNT_PATH}?state=${encodeURIComponent(state)}`
  const headers: Record<string, string> = {
    [HTTP_HEADER_DOMAIN]: token.domain,
    Authorization: `Bearer ${token.accessToken}`,
    [HTTP_HEADER_NO_USER_ID]: 'true',
    [HTTP_HEADER_NO_ENTERPRISE_ID]: 'true',
    'User-Agent': BUDDY_USER_AGENT,
  }
  const deadline = Date.now() + (options.timeoutMs ?? LOGIN_TIMEOUT_MS)
  const interval = options.pollIntervalMs ?? POLL_INTERVAL_MS
  for (;;) {
    if (Date.now() >= deadline) throw new Error('获取账户信息超时（5 分钟）')
    if (options.signal?.aborted) throw new Error('登录已取消')
    await sleep(interval)
    let result: { status: number; body: unknown }
    try {
      result = await request('GET', url, headers, {
        fetcher, timeoutMs: REQUEST_TIMEOUT_MS, ...options.signal !== undefined ? { signal: options.signal } : {},
      })
    } catch {
      continue
    }
    const { status, body } = result
    if (status === 200) {
      const data = responseData(body)
      if (data !== undefined) return parseAccountData(data)
      continue
    }
    const code = responseCode(body)
    if (code === CODE_ACCOUNT_NOT_READY) continue
    throw new Error(`login/account HTTP ${status} code=${code}: ${responseMessage(body)}`)
  }
}

/**
 * POST /v2/plugin/auth/token/refresh 静默续期。
 *
 * 通过 X-Refresh-Token 头提交 refresh_token；成功时返回新令牌数据。
 * refresh_token 被后端判定失效（401/403 或 message 含 expired/invalid）时抛
 * {@link RefreshTokenExpiredError}，调用方据此停止续期并提示重新登录。
 */
export async function refreshToken(
  credential: BuddyCredential,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<BuddyToken> {
  if (!isRefreshable(credential)) {
    throw new RefreshTokenExpiredError('无 refresh_token，请重新登录')
  }
  const url = `${API_ENDPOINT}${AUTH_REFRESH_PATH}`
  const headers: Record<string, string> = {
    ...credentialRequestHeaders(credential),
    Authorization: `Bearer ${credential.access_token}`,
    [HTTP_HEADER_REFRESH_TOKEN]: credential.refresh_token,
    [HTTP_HEADER_AUTH_REFRESH_SOURCE]: AUTH_REFRESH_SOURCE,
  }
  const { status, body } = await request('POST', url, headers, {
    fetcher, timeoutMs: REQUEST_TIMEOUT_MS, ...signal !== undefined ? { signal } : {},
  })
  if (status !== 200) {
    const code = responseCode(body)
    const message = responseMessage(body)
    // 终态判定：HTTP 401/403、后端错误码 401/403，或 message 明确为
    // expired/invalid —— 都视为 refresh_token 已失效（停止调度、提示重新登录），
    // 避免每次刷新失败都被当作可重试错误而无限重试。
    const expired = status === 401 || status === 403
      || code === 401 || code === 403
      || message.includes('expired') || message.includes('invalid')
    if (expired) {
      throw new RefreshTokenExpiredError(message.length > 0 ? message : `HTTP ${status}`)
    }
    throw new Error(`刷新 token HTTP ${status} code=${code}: ${message}`)
  }
  const data = responseData(body)
  if (data === undefined) throw new Error('刷新 token 响应缺少 data 字段')
  return parseTokenData(data)
}

/** refresh_token 已失效/被拒绝时抛出的错误；调度器据此停止续期。 */
export class RefreshTokenExpiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RefreshTokenExpiredError'
  }
}

/**
 * GET /v3/config → 获取远端模型列表（craft agent 的 models）。
 *
 * 失败时返回空数组（调用方回退到内置列表）。
 */
export async function fetchModels(
  credential: BuddyCredential,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Array<{ id: string; name: string; contextWindow?: number }>> {
  if (credential.access_token.length === 0) return []
  const url = `${API_ENDPOINT}${CONFIG_PATH}`
  const headers: Record<string, string> = {
    ...credentialAuthHeaders(credential),
    [HTTP_HEADER_PRODUCT]: BUDDY_DEPLOYMENT_TYPE,
    [HTTP_HEADER_PRODUCT_CODE]: BUDDY_PRODUCT_CODE,
  }
  try {
    const { status, body } = await request('GET', url, headers, {
      fetcher, timeoutMs: REQUEST_TIMEOUT_MS, ...signal !== undefined ? { signal } : {},
    })
    if (status !== 200) return []
    return parseModelsFromConfig(body)
  } catch {
    return []
  }
}

/** 等待指定的毫秒数。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.()
  })
}

/** 默认的平台浏览器打开器（延迟 import 以复用 CodeArts 的实现）。 */
async function defaultOpenBrowser(url: string): Promise<void> {
  const { openBrowser } = await import('./login.js')
  openBrowser(url)
}

/**
 * 完整登录流程：fetchAuthState → 打开浏览器 → 轮询 token → 轮询 account。
 *
 * 返回序列化后的凭据 JSON；持久化由调用方（BuddyAuth 服务）负责，
 * 与 CodeArts 的 runOAuthFlow 保持一致的分层。
 */
export async function runBuddyLoginFlow(options: BuddyLoginFlowOptions = {}): Promise<BuddyLoginFlowResult> {
  const fetcher = options.fetcher ?? fetch
  const open = options.openBrowser ?? defaultOpenBrowser

  const { state, authUrl } = await fetchAuthState(fetcher)
  await open(authUrl)

  const pollOptions = {
    fetcher,
    ...options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {},
    ...options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {},
  }
  const token = await loopGetToken(state, pollOptions)
  const account = await getAccount(state, token, pollOptions)
  const credential = buildCredential(token, account)
  return {
    access: JSON.stringify(credential),
    // 对齐 Rust 的 expires_at_ms(...).unwrap_or(0)：无法解析时报告 0。
    expires: credentialExpiresAtMs(credential) ?? 0,
    loginUrl: authUrl,
    refreshable: isRefreshable(credential),
  }
}
