import { describe, expect, it, vi } from 'vitest'
import {
  buildLoginUrl,
  expiresFromCredential,
  generateRandomSecret,
  parseCredentialResponse,
  pollForCredential,
  runLoginFlow,
  startCallbackServer,
} from '../../src/login.js'
import type { CodeArtsCredential } from '../../src/types.js'

describe('generateRandomSecret', () => {
  it('produces 64 lowercase hex chars and differs across calls', () => {
    const a = generateRandomSecret()
    const b = generateRandomSecret()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
  })
})

describe('buildLoginUrl', () => {
  it('wraps the redirect into the Huawei auth page', () => {
    const { redirectUrl, loginUrl } = buildLoginUrl(43123, 'ticket-123')
    expect(redirectUrl).toBe(
      'https://devcloud.cn-north-4.huaweicloud.com/doer/redirect'
        + '?IdeaType=jetbrains'
        + `&auth_callback_url=${encodeURIComponent('http://127.0.0.1:43123/authentication')}`
        + '&plugin-name=snap_jetbrains&plugin-version=26.3.3'
        + '&ticket_id=ticket-123',
    )
    expect(loginUrl).toBe(
      'https://auth.huaweicloud.com/authui/login.html'
        + `?service=${encodeURIComponent(redirectUrl)}`,
    )
  })
})

describe('parseCredentialResponse', () => {
  it('parses the credential branch', () => {
    const c = parseCredentialResponse({
      credential: {
        access: 'AK',
        secret: 'SK',
        securitytoken: 'ST',
        expires_at: '2026-08-15T00:00:00Z',
      },
      domain_id: 'dom', user_id: 'uid', user_name: 'uname',
    })
    expect(c).toEqual({
      access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
      expires_at: '2026-08-15T00:00:00Z',
      domain_id: 'dom', user_id: 'uid', user_name: 'uname',
    })
  })

  it('parses the result branch (camelCase)', () => {
    const c = parseCredentialResponse({
      result: { accessKeyId: 'AK', secretAccessKey: 'SK', securityToken: 'ST', expiration: '2026-08-15T00:00:00Z' },
    })
    expect(c).toEqual({
      access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
      expires_at: '2026-08-15T00:00:00Z',
    })
  })

  it('returns null when a branch is incomplete', () => {
    expect(parseCredentialResponse({ credential: { access: 'AK' } })).toBeNull()
    expect(parseCredentialResponse({})).toBeNull()
  })
})

describe('expiresFromCredential', () => {
  it('parses expires_at and falls back to +24h', () => {
    const parsed: CodeArtsCredential = {
      access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
      expires_at: '2026-08-15T00:00:00Z',
    }
    expect(expiresFromCredential(parsed)).toBe(Date.parse('2026-08-15T00:00:00Z'))
    expect(expiresFromCredential({ ...parsed, expires_at: 'garbage' })).toBeGreaterThan(Date.now())
  })
})

describe('pollForCredential', () => {
  const complete = JSON.stringify({
    credential: { access: 'AK', secret: 'SK', securitytoken: 'ST', expires_at: '2026-08-15T00:00:00Z' },
  })

  it('returns the first complete credential', async () => {
    const fetcher = vi.fn(async () => new Response(complete, { status: 200 }))
    const credential = await pollForCredential('ticket-1', 'secret-1', { fetcher, maxAttempts: 3 })
    expect(credential.access_key_id).toBe('AK')
    expect(credential.security_token).toBe('ST')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('skips non-ok responses, unparseable bodies, and incomplete branches', async () => {
    let calls = 0
    const fetcher = vi.fn(async () => {
      calls += 1
      if (calls === 1) return new Response('nope', { status: 500 })
      if (calls === 2) return new Response('not json', { status: 200 })
      if (calls === 3) return new Response(JSON.stringify({ credential: { access: 'AK' } }), { status: 200 })
      return new Response(complete, { status: 200 })
    })
    const credential = await pollForCredential('ticket-1', 'secret-1', { fetcher, maxAttempts: 4 })
    expect(credential.access_key_id).toBe('AK')
    expect(calls).toBe(4)
  })

  it('survives transient network errors', async () => {
    let calls = 0
    const fetcher = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw new Error('ECONNRESET')
      return new Response(complete, { status: 200 })
    })
    const credential = await pollForCredential('ticket-1', 'secret-1', { fetcher, maxAttempts: 2 })
    expect(credential.access_key_id).toBe('AK')
  })

  it('throws when the budget is exhausted', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
    await expect(pollForCredential('ticket-1', 'secret-1', { fetcher, maxAttempts: 2 }))
      .rejects.toThrow('CodeArts login timed out')
  })

  it('builds the expected endpoint URL with encoded query values', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
    await expect(pollForCredential('a b', 'c&d', { fetcher, maxAttempts: 1 })).rejects.toThrow()
    const url = new URL(fetcher.mock.calls[0][0] as string)
    expect(url.searchParams.get('ticket_id')).toBe('a b')
    expect(url.searchParams.get('secret')).toBe('c&d')
  })
})

describe('startCallbackServer', () => {
  const complete = JSON.stringify({
    credential: { access: 'AK', secret: 'SK', securitytoken: 'ST', expires_at: '2026-08-15T00:00:00Z' },
  })

  async function hit(port: number, path: string, init?: RequestInit): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, init)
  }

  it('resolves a direct token callback', async () => {
    const server = await startCallbackServer('ticket-1', 'secret-1', {})
    try {
      const response = await hit(server.port, '/authentication?token=abc')
      expect(response.status).toBe(200)
      const result = await server.result
      expect(result.access).toBe('abc')
      expect(result.expires).toBeGreaterThan(Date.now())
    } finally {
      await new Promise((resolve) => server.server.close(resolve))
    }
  })

  it('resolves the fingerprint branch (base64 URL containing a token)', async () => {
    const server = await startCallbackServer('ticket-1', 'secret-1', {})
    try {
      const inner = `http://host/cb?access_token=fp-token`
      const fingerprint = Buffer.from(inner).toString('base64')
      const response = await hit(server.port, `/authentication?fingerprint=${encodeURIComponent(fingerprint)}`)
      expect(response.status).toBe(200)
      const result = await server.result
      expect(result.access).toBe('fp-token')
    } finally {
      await new Promise((resolve) => server.server.close(resolve))
    }
  })

  it('resolves the secret branch through polling', async () => {
    const fetcher = vi.fn(async () => new Response(complete, { status: 200 }))
    const server = await startCallbackServer('ticket-1', 'secret-1', { fetcher, maxAttempts: 3 })
    try {
      const response = await hit(server.port, '/authentication?secret=cb-secret')
      expect(response.status).toBe(200)
      const result = await server.result
      const credential = JSON.parse(result.access) as CodeArtsCredential
      expect(credential.access_key_id).toBe('AK')
      expect(credential.security_token).toBe('ST')
    } finally {
      await new Promise((resolve) => server.server.close(resolve))
    }
  })

  it('answers 404 for foreign paths and 400 for a tokenless callback', async () => {
    const server = await startCallbackServer('ticket-1', 'secret-1', {})
    try {
      expect((await hit(server.port, '/other')).status).toBe(404)
      expect((await hit(server.port, '/authentication')).status).toBe(400)
    } finally {
      await new Promise((resolve) => server.server.close(resolve))
    }
  })
})

describe('runLoginFlow', () => {
  it('opens the login URL, resolves through a direct token callback, and closes the server', async () => {
    const opened: string[] = []
    const flow = runLoginFlow({ openBrowser: (url) => void opened.push(url) })
    // 服务器在 promise 完成后启动；通过流程的 loginUrl 等待端口。
    // 通过从 login URL 中解码端口号来模拟浏览器回调。
    const loginUrl = await waitFor(() => opened[0])
    const service = new URL(loginUrl).searchParams.get('service') as string
    const redirect = new URL(decodeURIComponent(service))
    const callback = new URL(redirect.searchParams.get('auth_callback_url') as string)
    const response = await fetch(`http://127.0.0.1:${callback.port}/authentication?token=from-browser`)
    expect(response.status).toBe(200)
    const result = await flow
    expect(result.access).toBe('from-browser')
    expect(result.loginUrl).toBe(loginUrl)
  })
})

async function waitFor<T>(get: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = get()
    if (value !== undefined) return value
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
