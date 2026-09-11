import { describe, it, expect, beforeEach } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { AccountPool } from '../../src/account-pool.js'
import type { ProviderAccountEntry } from '../../src/types.js'

/** 伪造的 MockContext */
function createMockContext(initialAccounts: ProviderAccountEntry[] = []) {
  let stored: { accounts?: ProviderAccountEntry[] } = { accounts: initialAccounts }
  const mockSettings = {
    // AccountPool 构造时注册 namespace，拿到 owner scope
    register: (_ns: string, _schema: unknown) => ({
      get: () => stored,
      replace: async (value: { accounts?: ProviderAccountEntry[] }) => {
        stored = value
      },
    }),
    describe: () => [{ ns: 'jet-hub', value: stored }],
  }
  const mockCredentials = new Map<string, string>()
  return {
    logger: { warn: () => {} },
    get: (key: string) => key === 'settings' ? mockSettings : undefined,
    credentials: {
      describe: async (ref: ReturnType<typeof credentialRef>) => {
        const key = typeof ref === 'string' ? ref : String(ref)
        return { configured: mockCredentials.has(key), source: 'test' as const, writable: true }
      },
      resolve: async (ref: ReturnType<typeof credentialRef>) => {
        const key = typeof ref === 'string' ? ref : String(ref)
        const value = mockCredentials.get(key)
        return value ? { value, source: 'test' as const } : undefined
      },
      set: async (ref: ReturnType<typeof credentialRef>, value: string) => {
        const key = typeof ref === 'string' ? ref : String(ref)
        mockCredentials.set(key, value)
      },
      unset: async (ref: ReturnType<typeof credentialRef>) => {
        const key = typeof ref === 'string' ? ref : String(ref)
        mockCredentials.delete(key)
      },
    },
  }
}

describe('AccountPool', () => {
  let ctx: ReturnType<typeof createMockContext>
  let pool: AccountPool

  /** 每次通过工厂返回新对象，避免测试间 Object.assign 污染共享引用 */
  function makeMockAccount(overrides: Partial<ProviderAccountEntry> = {}): ProviderAccountEntry {
    return {
      id: 'buddy-001',
      provider: 'buddy',
      nickname: 'test-user',
      enabled: true,
      credentialRef: 'BUDDY_ACCOUNT_T1',
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600000,
      refreshable: true,
      ...overrides,
    }
  }

  beforeEach(() => {
    ctx = createMockContext()
    pool = new AccountPool(ctx as any)
  })

  it('should add and list accounts', async () => {
    await pool.addAccount(makeMockAccount())
    const list = await pool.listAccounts('buddy')
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('buddy-001')
  })

  it('should filter by provider', async () => {
    await pool.addAccount(makeMockAccount())
    await pool.addAccount(makeMockAccount({ id: 'codearts-001', provider: 'codearts', credentialRef: 'CODEARTS_ACCOUNT_C1' }))
    const buddyAccounts = await pool.listAccounts('buddy')
    const codeartsAccounts = await pool.listAccounts('codearts')
    expect(buddyAccounts).toHaveLength(1)
    expect(codeartsAccounts).toHaveLength(1)
  })

  it('should update account', async () => {
    await pool.addAccount(makeMockAccount())
    await pool.updateAccount('buddy-001', { enabled: false })
    const list = await pool.listAccounts('buddy')
    expect(list[0].enabled).toBe(false)
  })

  it('should throw on update for non-existent account', async () => {
    await expect(pool.updateAccount('nonexistent', { enabled: false })).rejects.toThrow('Account nonexistent not found')
  })

  it('should remove account and credential', async () => {
    await pool.addAccount(makeMockAccount())
    // 先设一个凭据，确认删除时清理
    await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_T1'), JSON.stringify({ access_token: 'test' }))
    await pool.removeAccount('buddy-001')
    const list = await pool.listAccounts('buddy')
    expect(list).toHaveLength(0)
    const resolved = await ctx.credentials.resolve(credentialRef('BUDDY_ACCOUNT_T1'))
    expect(resolved).toBeUndefined()
  })

  it('should return available account for model', async () => {
    // 为两个账号都设置凭据
    await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_T1'), JSON.stringify({ access_token: 'test1' }))
    await pool.addAccount(makeMockAccount())
    // 为第二个账号设置模型限流
    await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_T2'), JSON.stringify({ access_token: 'test2' }))
    await pool.addAccount(makeMockAccount({
      id: 'buddy-002',
      credentialRef: 'BUDDY_ACCOUNT_T2',
      modelRateLimits: { 'deepseek-v4-flash': Date.now() + 3600000 },
    }))
    const result = await pool.getAvailableAccount('buddy', 'deepseek-v4-flash')
    expect(result).not.toBeNull()
    expect(result!.entry.id).toBe('buddy-001')
  })

  it('should return null when all accounts rate-limited', async () => {
    await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_T1'), JSON.stringify({ access_token: 'test' }))
    await pool.addAccount(makeMockAccount({
      modelRateLimits: { 'deepseek-v4-flash': Date.now() + 3600000 },
    }))
    const result = await pool.getAvailableAccount('buddy', 'deepseek-v4-flash')
    expect(result).toBeNull()
  })

  it('should return null when no accounts at all', async () => {
    const result = await pool.getAvailableAccount('buddy', 'deepseek-v4-flash')
    expect(result).toBeNull()
  })

  it('should return null when credential resolve fails', async () => {
    await pool.addAccount(makeMockAccount())
    const result = await pool.getAvailableAccount('buddy', 'deepseek-v4-flash')
    expect(result).toBeNull()
  })

  it('should return null when credential JSON parse fails', async () => {
    await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_T1'), 'not-json')
    await pool.addAccount(makeMockAccount())
    const result = await pool.getAvailableAccount('buddy', 'deepseek-v4-flash')
    expect(result).toBeNull()
  })

  it('should update model rate limit', async () => {
    await pool.addAccount(makeMockAccount())
    const resetAt = Date.now() + 7200000
    await pool.updateModelRateLimit('buddy-001', 'deepseek-v4-flash', resetAt)
    const list = await pool.listAccounts('buddy')
    expect(list[0].modelRateLimits?.['deepseek-v4-flash']).toBe(resetAt)
  })

  it('should sweep expired rate limits', async () => {
    await pool.addAccount(makeMockAccount({
      modelRateLimits: { 'deepseek-v4-flash': Date.now() - 1000, 'deepseek-v4-pro': Date.now() + 3600000 },
    }))
    await pool.sweepExpiredRateLimits()
    const list = await pool.listAccounts('buddy')
    expect(list[0].modelRateLimits?.['deepseek-v4-flash']).toBeUndefined()
    expect(list[0].modelRateLimits?.['deepseek-v4-pro']).toBeDefined()
  })

  it('should list all accounts', async () => {
    await pool.addAccount(makeMockAccount())
    await pool.addAccount(makeMockAccount({ id: 'codearts-001', provider: 'codearts', credentialRef: 'CODEARTS_ACCOUNT_C1' }))
    const all = await pool.listAllAccounts()
    expect(all).toHaveLength(2)
  })

  it('should handle removeAccount of non-existent account gracefully', async () => {
    await pool.removeAccount('nonexistent')
    const list = await pool.listAllAccounts()
    expect(list).toHaveLength(0)
  })

  it('should handle updateModelRateLimit for non-existent account gracefully', async () => {
    await pool.updateModelRateLimit('nonexistent', 'deepseek-v4-flash', Date.now() + 3600000)
    // 不会抛出
  })
})
