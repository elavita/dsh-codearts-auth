import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RefreshTokenExpiredError,
  fetchAuthState,
  fetchModels,
  getAccount,
  loopGetToken,
  refreshToken,
  runBuddyLoginFlow,
} from '../../src/buddy-oauth.js'
import type { BuddyCredential } from '../../src/buddy.js'

const STATE = 'state-abc'
const AUTH_URL = 'https://www.codebuddy.cn/login/?platform=ide&state=state-abc'

/** 构造凭据（默认 2 小时后过期）。 */
function makeCredential(overrides: Partial<BuddyCredential> = {}): BuddyCredential {
  return {
    access_token: 'AT',
    refresh_token: 'RT',
    expires_at: String(Date.now() + 7_200_000),
    token_type: 'Bearer',
    scope: '',
    domain: 'copilot.tencent.com',
    ...overrides,
  }
}

/** 把若干个 [matcher, response] 规则组装为 stub fetch。 */
function routeFetch(routes: Array<{ when: (url: string) => boolean; respond: () => Response }>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    for (const route of routes) {
      if (route.when(url)) return route.respond()
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('buddy fetchAuthState', () => {
  it('returns state and authUrl', async () => {
    const fetcher = routeFetch([{
      when: (url) => url.includes('/v2/plugin/auth/state'),
      respond: () => new Response(JSON.stringify({ code: 0, data: { state: STATE, authUrl: AUTH_URL } }), { status: 200 }),
    }])
    const result = await fetchAuthState(fetcher)
    expect(result).toEqual({ state: STATE, authUrl: AUTH_URL })
    // 必须带 platform=ide 查询参数与免鉴权头。
    const [url, init] = (fetcher as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]
    expect(url).toContain('platform=ide')
    expect((init.headers as Record<string, string>)['X-No-Authorization']).toBe('true')
  })

  it('throws when the response is missing state or authUrl', async () => {
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 }),
    }])
    await expect(fetchAuthState(fetcher)).rejects.toThrow('state')
  })

  it('throws on a non-200 response', async () => {
    const fetcher = routeFetch([{ when: () => true, respond: () => new Response('boom', { status: 500 }) }])
    await expect(fetchAuthState(fetcher)).rejects.toThrow('auth/state HTTP 500')
  })
})

describe('buddy loopGetToken', () => {
  it('polls until the token is ready', async () => {
    let attempts = 0
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => {
        attempts++
        // 前两次返回 11217（token 未就绪），第三次成功。
        return attempts < 3
          ? new Response(JSON.stringify({ code: 11217, message: 'not ready' }), { status: 400 })
          : new Response(JSON.stringify({
            code: 0,
            data: { accessToken: 'AT', refreshToken: 'RT', expiresAt: '2026-08-30T00:00:00Z', tokenType: 'Bearer', scope: '', domain: 'copilot.tencent.com' },
          }), { status: 200 })
      },
    }])
    const token = await loopGetToken(STATE, { fetcher, pollIntervalMs: 0 })
    expect(token.accessToken).toBe('AT')
    expect(attempts).toBe(3)
  })

  it('aborts other errors immediately', async () => {
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => new Response(JSON.stringify({ code: 99999, message: 'fatal' }), { status: 400 }),
    }])
    await expect(loopGetToken(STATE, { fetcher, pollIntervalMs: 0 })).rejects.toThrow('fatal')
  })

  it('times out when the token never becomes ready', async () => {
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => new Response(JSON.stringify({ code: 11217 }), { status: 400 }),
    }])
    await expect(loopGetToken(STATE, { fetcher, pollIntervalMs: 0, timeoutMs: 5 })).rejects.toThrow('超时')
  })
})

describe('buddy getAccount', () => {
  it('polls until the account is ready', async () => {
    let attempts = 0
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => {
        attempts++
        return attempts < 2
          ? new Response(JSON.stringify({ code: 12151 }), { status: 400 })
          : new Response(JSON.stringify({ code: 0, data: { uid: 'u1', nickname: 'nick', enterpriseId: '', type: 'personal' } }), { status: 200 })
      },
    }])
    const account = await getAccount(STATE, {
      accessToken: 'AT', refreshToken: 'RT', expiresAt: '', refreshExpiresAt: '', tokenType: 'Bearer', scope: '', domain: 'copilot.tencent.com',
    }, { fetcher, pollIntervalMs: 0 })
    expect(account).toEqual({ uid: 'u1', nickname: 'nick', enterpriseId: '', accountType: 'personal' })
  })

  it('times out when the account never becomes ready', async () => {
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => new Response(JSON.stringify({ code: 12151 }), { status: 400 }),
    }])
    const token = {
      accessToken: 'AT', refreshToken: 'RT', expiresAt: '', refreshExpiresAt: '', tokenType: 'Bearer', scope: '', domain: 'copilot.tencent.com',
    }
    await expect(getAccount(STATE, token, { fetcher, pollIntervalMs: 0, timeoutMs: 5 })).rejects.toThrow('超时')
  })
})

describe('buddy refreshToken', () => {
  it('submits X-Refresh-Token and returns the new token', async () => {
    const fetcher = routeFetch([{
      when: (url) => url.includes('/v2/plugin/auth/token/refresh'),
      respond: () => new Response(JSON.stringify({
        code: 0,
        data: { accessToken: 'AT2', refreshToken: 'RT2', expiresAt: '2026-09-30T00:00:00Z', refreshExpiresAt: '', tokenType: 'Bearer', scope: '', domain: 'copilot.tencent.com' },
      }), { status: 200 }),
    }])
    const token = await refreshToken(makeCredential(), fetcher)
    expect(token.accessToken).toBe('AT2')
    expect(token.refreshToken).toBe('RT2')
    const [, init] = (fetcher as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['X-Refresh-Token']).toBe('RT')
  })

  it('throws RefreshTokenExpiredError on HTTP 401', async () => {
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => new Response(JSON.stringify({ code: 401, message: 'refresh token expired' }), { status: 401 }),
    }])
    await expect(refreshToken(makeCredential(), fetcher)).rejects.toBeInstanceOf(RefreshTokenExpiredError)
  })

  it('throws RefreshTokenExpiredError when the message says expired', async () => {
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => new Response(JSON.stringify({ code: 5000, message: 'token expired' }), { status: 400 }),
    }])
    await expect(refreshToken(makeCredential(), fetcher)).rejects.toThrow('expired')
  })

  it('treats other failures as retryable (plain Error)', async () => {
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => new Response(JSON.stringify({ code: 500, message: 'upstream down' }), { status: 502 }),
    }])
    const error = await refreshToken(makeCredential(), fetcher).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(RefreshTokenExpiredError)
  })

  it('throws RefreshTokenExpiredError when there is no refresh_token', async () => {
    const fetcher = routeFetch([])
    await expect(refreshToken(makeCredential({ refresh_token: '' }), fetcher)).rejects.toBeInstanceOf(RefreshTokenExpiredError)
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('buddy fetchModels', () => {
  it('parses the craft agent models from /v3/config', async () => {
    const fetcher = routeFetch([{
      when: (url) => url.includes('/v3/config'),
      respond: () => new Response(JSON.stringify({
        data: { agents: [{ name: 'craft', models: ['auto', 'hy4-preview', 'glm-5.3'] }] },
      }), { status: 200 }),
    }])
    expect(await fetchModels(makeCredential(), fetcher)).toEqual([
      { id: 'hy4-preview', name: 'Hy4 Preview' },
      { id: 'glm-5.3', name: 'GLM-5.3' },
    ])
  })

  it('returns an empty list without a token or on failure', async () => {
    const fetcher = routeFetch([{ when: () => true, respond: () => new Response('nope', { status: 500 }) }])
    expect(await fetchModels(makeCredential({ access_token: '' }), fetcher)).toEqual([])
    expect(await fetchModels(makeCredential(), fetcher)).toEqual([])
  })
})

describe('buddy runBuddyLoginFlow', () => {
  it('runs state → browser → token → account and returns the serialized credential', async () => {
    const opened: string[] = []
    const fetcher = routeFetch([
      {
        when: (url) => url.includes('/auth/state'),
        respond: () => new Response(JSON.stringify({ code: 0, data: { state: STATE, authUrl: AUTH_URL } }), { status: 200 }),
      },
      {
        when: (url) => url.includes('/auth/token'),
        respond: () => new Response(JSON.stringify({
          code: 0,
          data: { accessToken: 'AT', refreshToken: 'RT', expiresAt: '2026-08-30T00:00:00Z', refreshExpiresAt: '', tokenType: 'Bearer', scope: '', domain: 'copilot.tencent.com' },
        }), { status: 200 }),
      },
      {
        when: (url) => url.includes('/login/account'),
        respond: () => new Response(JSON.stringify({ code: 0, data: { uid: 'u1', nickname: 'nick', enterpriseId: '', type: 'personal' } }), { status: 200 }),
      },
    ])

    const result = await runBuddyLoginFlow({
      fetcher,
      pollIntervalMs: 0,
      openBrowser: (url) => { opened.push(url) },
    })

    expect(opened).toEqual([AUTH_URL])
    expect(result.loginUrl).toBe(AUTH_URL)
    expect(result.refreshable).toBe(true)
    expect(result.expires).toBe(Date.parse('2026-08-30T00:00:00Z'))
    const credential = JSON.parse(result.access) as BuddyCredential
    expect(credential).toMatchObject({
      access_token: 'AT', refresh_token: 'RT', user_id: 'u1', nickname: 'nick', account_type: 'personal',
    })
  })

  it('propagates auth/state failures and never opens the browser', async () => {
    const opened: string[] = []
    const fetcher = routeFetch([{ when: () => true, respond: () => new Response('boom', { status: 500 }) }])
    await expect(runBuddyLoginFlow({
      fetcher,
      pollIntervalMs: 0,
      openBrowser: (url) => { opened.push(url) },
    })).rejects.toThrow('auth/state HTTP 500')
    expect(opened).toEqual([])
  })
})
