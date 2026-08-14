import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runLoginFlow } from '../../src/login.js'
import { CODEARTS_CREDENTIAL_REF, CodeArtsAuth } from '../../src/service.js'

vi.mock('../../src/login.js', () => ({
  runLoginFlow: vi.fn(),
}))

const mockedRunLoginFlow = vi.mocked(runLoginFlow)

/** 最小化的内存凭据提供者，形状与 ctx.credentials 一致。 */
class FakeCredentials {
  private store = new Map<string, string>()
  async resolve(ref: string) {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: string) {
    return { configured: this.store.has(ref), source: this.store.has(ref) ? 'fake' : undefined, writable: true }
  }
  async set(ref: string, value: string) { this.store.set(ref, value) }
  async unset(ref: string) { this.store.delete(ref) }
}

function makeContext(): { ctx: Context; credentials: FakeCredentials } {
  const ctx = new Context()
  const credentials = new FakeCredentials()
  ctx.provide('credentials', credentials as never)
  return { ctx, credentials }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('CodeArtsAuth', () => {
  it('registers as ctx.codeartsAuth on construction', () => {
    const { ctx } = makeContext()
    const service = new CodeArtsAuth(ctx)
    // cordis 通过其反射层提供服务，因此不保证
    // 身份相等（`===`）；instanceof 和名称才是契约。
    expect(ctx.codeartsAuth).toBeInstanceOf(CodeArtsAuth)
    expect(ctx.codeartsAuth.name).toBe('codeartsAuth')
  })

  it('login stores the flow access value under the fixed ref', async () => {
    mockedRunLoginFlow.mockResolvedValue({ access: 'json-credential', expires: 1234, loginUrl: 'https://login' })
    const { ctx, credentials } = makeContext()
    const service = new CodeArtsAuth(ctx)
    const result = await service.login()
    expect(await credentials.resolve(CODEARTS_CREDENTIAL_REF)).toEqual({ value: 'json-credential', source: 'fake' })
    expect(result).toMatchObject({ access: 'json-credential', expires: 1234, loginUrl: 'https://login' })
    expect(String(result.ref)).toBe(CODEARTS_CREDENTIAL_REF)
  })

  it('login forwards flow options and propagates failures', async () => {
    mockedRunLoginFlow.mockRejectedValue(new Error('CodeArts login timed out'))
    const { ctx } = makeContext()
    const service = new CodeArtsAuth(ctx)
    await expect(service.login({ maxAttempts: 1 })).rejects.toThrow('CodeArts login timed out')
    expect(mockedRunLoginFlow).toHaveBeenCalledWith({ maxAttempts: 1 })
  })

  it('status reports unconfigured without a stored value', async () => {
    const { ctx } = makeContext()
    const service = new CodeArtsAuth(ctx)
    expect(await service.status()).toEqual({ configured: false, refreshable: false })
  })

  it('status parses expires_at from the stored JSON credential', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(CODEARTS_CREDENTIAL_REF, JSON.stringify({ access_key_id: 'AK', expires_at: '2026-08-15T00:00:00Z' }))
    const service = new CodeArtsAuth(ctx)
    expect(await service.status()).toEqual({
      configured: true,
      source: 'fake',
      expiresAt: Date.parse('2026-08-15T00:00:00Z'),
      refreshable: true,
    })
  })

  it('status tolerates a raw-token credential without expiry metadata', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(CODEARTS_CREDENTIAL_REF, 'raw-token')
    const service = new CodeArtsAuth(ctx)
    expect(await service.status()).toEqual({ configured: true, source: 'fake', expiresAt: undefined, refreshable: true })
  })

  it('logout removes the stored credential', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(CODEARTS_CREDENTIAL_REF, 'value')
    const service = new CodeArtsAuth(ctx)
    await service.logout()
    expect(await credentials.resolve(CODEARTS_CREDENTIAL_REF)).toBeUndefined()
  })
})

describe('CodeArtsAuth refresh', () => {
  it('refresh re-runs the login flow and rewrites the credential', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(CODEARTS_CREDENTIAL_REF, JSON.stringify({
      access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
      expires_at: '2026-08-14T12:00:00Z',
    }))
    mockedRunLoginFlow.mockResolvedValue({
      access: '{"access_key_id":"AK2","secret_access_key":"SK2","security_token":"ST2","expires_at":"2026-08-16T00:00:00Z"}',
      expires: Date.parse('2026-08-16T00:00:00Z'),
      loginUrl: 'https://login',
    })
    const service = new CodeArtsAuth(ctx)
    await service.refresh()
    const stored = JSON.parse((await credentials.resolve(CODEARTS_CREDENTIAL_REF))!.value) as Record<string, string>
    expect(stored.access_key_id).toBe('AK2')
    expect(mockedRunLoginFlow).toHaveBeenCalled()
  })

  it('refresh propagates login failures to the caller', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(CODEARTS_CREDENTIAL_REF, JSON.stringify({
      access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST', expires_at: '',
    }))
    mockedRunLoginFlow.mockRejectedValue(new Error('CodeArts login timed out'))
    const service = new CodeArtsAuth(ctx)
    await expect(service.refresh()).rejects.toThrow('CodeArts login timed out')
  })
})
