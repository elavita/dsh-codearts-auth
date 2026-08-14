import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { getRandomValues, randomUUID } from 'node:crypto'
import type { CodeArtsCredential, CodeArtsCredentialResponse, LoginFlowOptions, LoginFlowResult } from './types.js'

export const CODEARTS_LOGIN_BASE = 'https://devcloud.cn-north-4.huaweicloud.com/doer/redirect'
export const HUAWEI_AUTH_BASE = 'https://auth.huaweicloud.com/authui/login.html'
export const CREDENTIAL_ENDPOINT = 'https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager/v1/login/ticket'

const PLUGIN_NAME = 'snap_jetbrains'
const PLUGIN_VERSION = '26.3.3'

/** 与重定向流程共享的随机 64 字符小写十六进制密钥。 */
export function generateRandomSecret(): string {
  const bytes = getRandomValues(new Uint8Array(32))
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 构建 doer/redirect URL 及包裹它的华为认证页面 URL。 */
export function buildLoginUrl(port: number, ticketId: string): { redirectUrl: string; loginUrl: string } {
  const callbackUrl = `http://127.0.0.1:${port}/authentication`
  const redirectUrl = `${CODEARTS_LOGIN_BASE}?IdeaType=jetbrains&auth_callback_url=${encodeURIComponent(callbackUrl)}&plugin-name=${PLUGIN_NAME}&plugin-version=${PLUGIN_VERSION}&ticket_id=${encodeURIComponent(ticketId)}`
  const loginUrl = `${HUAWEI_AUTH_BASE}?service=${encodeURIComponent(redirectUrl)}`
  return { redirectUrl, loginUrl }
}

/** 将一次 ticket 响应归一化为凭据，未完成时返回 null。 */
export function parseCredentialResponse(data: CodeArtsCredentialResponse): CodeArtsCredential | null {
  if (data.credential) {
    const access = data.credential.access ?? ''
    const st = data.credential.securitytoken ?? data.credential.securityToken ?? ''
    if (access && st) {
      return {
        access_key_id: access,
        secret_access_key: data.credential.secret ?? '',
        security_token: st,
        expires_at: data.credential.expires_at ?? data.credential.expiresAt ?? '',
        domain_id: data.domain_id ?? '',
        user_id: data.user_id ?? '',
        user_name: data.user_name ?? '',
      }
    }
  }
  if (data.result) {
    const ak = data.result.accessKeyId ?? ''
    const st = data.result.securityToken ?? ''
    if (ak && st) {
      return {
        access_key_id: ak,
        secret_access_key: data.result.secretAccessKey ?? '',
        security_token: st,
        expires_at: data.result.expiration ?? data.result.expiresAt ?? '',
      }
    }
  }
  return null
}

/** 凭据的过期时间戳（毫秒）；时间戳无法解析时回退为 +24 小时。 */
export function expiresFromCredential(credential: CodeArtsCredential): number {
  if (credential.expires_at) {
    const parsed = Date.parse(credential.expires_at)
    if (!Number.isNaN(parsed)) return parsed
  }
  return Date.now() + 86_400_000
}

/**
 * 轮询 ticket 端点，直到收到完整凭据或尝试
 * 次数耗尽。瞬时失败会被跳过，不会视为致命错误。
 */
export async function pollForCredential(
  ticketId: string,
  secret: string,
  options: { fetcher?: typeof fetch; maxAttempts?: number } = {},
): Promise<CodeArtsCredential> {
  const fetcher = options.fetcher ?? fetch
  const maxAttempts = options.maxAttempts ?? 120
  const url = `${CREDENTIAL_ENDPOINT}?ticket_id=${encodeURIComponent(ticketId)}&secret=${encodeURIComponent(secret)}`
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, 1000))
    let response: Response
    try {
      response = await fetcher(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          'plugin-name': PLUGIN_NAME,
          'plugin-version': PLUGIN_VERSION,
        },
      })
    } catch {
      continue
    }
    if (!response.ok) continue
    let data: CodeArtsCredentialResponse | null
    try {
      data = (await response.json()) as CodeArtsCredentialResponse
    } catch {
      continue
    }
    const credential = data ? parseCredentialResponse(data) : null
    if (credential) return credential
  }
  throw new Error('CodeArts login timed out')
}

/** 使用平台默认打开器打开 URL；永不抛出异常。 */
export function openBrowser(url: string): void {
  const win = process.platform === 'win32'
  const cmd = win ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = win ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    child.unref()
  } catch (error) {
    console.error('[codearts-auth] failed to open browser; open manually:', url, error)
  }
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  'Access-Control-Max-Age': '86400',
}

function pickToken(params: URLSearchParams): string {
  return params.get('token')
    ?? params.get('access_token')
    ?? params.get('accessToken')
    ?? params.get('authCode')
    ?? ''
}

/** 浏览器重定向的本地回调服务器；当某个分支完成时 resolve `result`。 */
export function startCallbackServer(
  ticketId: string,
  secret: string,
  options: LoginFlowOptions,
): Promise<{ port: number; server: ReturnType<typeof createServer>; result: Promise<LoginFlowResult> }> {
  let resolveResult!: (value: LoginFlowResult) => void
  let rejectResult!: (reason: unknown) => void
  const result = new Promise<LoginFlowResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${request.socket.localPort}`)
    if (url.pathname !== '/authentication' && !url.pathname.startsWith('/authentication')) {
      response.writeHead(404).end('Not found')
      return
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, CORS_HEADERS).end()
      return
    }
    const params = url.searchParams
    const directToken = pickToken(params)
    if (directToken) {
      response.writeHead(200, CORS_HEADERS).end()
      resolveResult({ access: directToken, expires: Date.now() + 86_400_000, loginUrl: '' })
      return
    }
    const fingerprint = params.get('fingerprint')
    if (fingerprint) {
      try {
        const decoded = Buffer.from(fingerprint, 'base64').toString()
        const fpToken = pickToken(new URL(decoded).searchParams)
        if (fpToken) {
          response.writeHead(200, CORS_HEADERS).end()
          resolveResult({ access: fpToken, expires: Date.now() + 86_400_000, loginUrl: '' })
          return
        }
      } catch {
        /* fingerprint 格式错误：继续到 400 */
      }
    }
    const callbackSecret = params.get('secret')
    if (callbackSecret) {
      response.writeHead(200, CORS_HEADERS).end()
      void pollForCredential(ticketId, callbackSecret, options).then(
        (credential) => resolveResult({
          access: JSON.stringify(credential),
          expires: expiresFromCredential(credential),
          loginUrl: '',
        }),
        (error) => rejectResult(error),
      )
      return
    }
    response.writeHead(400).end('Missing token or secret')
  })

  return new Promise((resolveStart, rejectStart) => {
    server.on('error', (error) => rejectStart(error))
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolveStart({ port, server, result })
    })
  })
}

/** 运行完整的浏览器登录流程，返回已存储的凭据值。 */
export async function runLoginFlow(options: LoginFlowOptions = {}): Promise<LoginFlowResult> {
  const ticketId = randomUUID()
  const secret = generateRandomSecret()
  const { port, server, result } = await startCallbackServer(ticketId, secret, options)
  const { loginUrl } = buildLoginUrl(port, ticketId)
  try {
    const opener = options.openBrowser ?? openBrowser
    await opener(loginUrl)
    const outcome = await result
    return { ...outcome, loginUrl }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}
