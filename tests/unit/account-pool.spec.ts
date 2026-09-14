import { describe, it, expect, beforeEach } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { AccountPool } from '../../src/account-pool.js'
import type { ProviderAccountEntry } from '../../src/types.js'

/**
 * 伪造的 MockContext。
 *
 * `staleReads` 选项模拟 DSH settings 服务的真实行为：`scope.get()` 返回的是
 * 服务内部的 resolved 快照，`replace()` 之后该快照未必立即更新。开启后
 * get() 会返回上一次 replace() 之前的值——用于复现"连续记录限流互相覆盖"。
 */
function createMockContext(
  initialAccounts: ProviderAccountEntry[] = [],
  options: { staleReads?: boolean } = {},
) {
  let stored: { accounts?: ProviderAccountEntry[] } = { accounts: initialAccounts }
  // 滞后读：get() 返回的这个值只在"下一次 replace 之后"才追平
  let visible: { accounts?: ProviderAccountEntry[] } = stored
  const replaceCalls: Array<ProviderAccountEntry[]> = []
  const mockSettings = {
    register: (_ns: string, _schema: unknown) => ({
      get: () => (options.staleReads ? visible : stored),
      replace: async (value: { accounts?: ProviderAccountEntry[] }) => {
        if (options.staleReads) {
          // 模拟滞后：get() 始终慢一拍，本次写入要等下一次 replace 才可见
          visible = stored
        }
        stored = value
        replaceCalls.push(value.accounts ?? [])
      },
    }),
    describe: () => [{ ns: 'jet-hub', value: stored }],
  }
  const mockCredentials = new Map<string, string>()
  return {
    replaceCalls,
    logger: { warn: () => {}, info: () => {} },
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

  // ── 停用账号绝不参与自动选择 ──
  // `getAvailableAccount` 是 provider 的凭据入口。停用只意味着"不自动参与
  // 轮换"，因此任何情况下都不能返回停用账号——包括 modelId 为空串时
  //（此时无法做限流过滤，最容易误把停用账号当成候选）。
  describe('停用账号不参与自动选择', () => {
    it('modelId 为空串时也不返回停用账号', async () => {
      await ctx.credentials.set(credentialRef('CA_OFF'), JSON.stringify({ access_key_id: 'off' }))
      await ctx.credentials.set(credentialRef('CA_ON'), JSON.stringify({ access_key_id: 'on' }))
      await pool.addAccount(makeMockAccount({
        id: 'codearts-off', provider: 'codearts', enabled: false, credentialRef: 'CA_OFF',
      }))
      await pool.addAccount(makeMockAccount({
        id: 'codearts-on', provider: 'codearts', enabled: true, credentialRef: 'CA_ON',
      }))

      const result = await pool.getAvailableAccount('codearts', '')
      expect(result).not.toBeNull()
      expect(result!.entry.id).toBe('codearts-on')
    })

    it('仅剩停用账号时返回 null（空 modelId 同样如此）', async () => {
      await ctx.credentials.set(credentialRef('CA_OFF'), JSON.stringify({ access_key_id: 'off' }))
      await pool.addAccount(makeMockAccount({
        id: 'codearts-off', provider: 'codearts', enabled: false, credentialRef: 'CA_OFF',
      }))

      expect(await pool.getAvailableAccount('codearts', '')).toBeNull()
      expect(await pool.getAvailableAccount('codearts', 'deepseek-v4-flash')).toBeNull()
    })

    it('空 modelId 会跳过限流过滤，但启用账号仍被返回', async () => {
      // 空 modelId 的语义：调用方还不知道目标模型，只能退化为"任取一个
      // 启用账号"。此处记录该既有行为，避免日后被误改成"一并过滤"。
      await ctx.credentials.set(credentialRef('CA_ON'), JSON.stringify({ access_key_id: 'on' }))
      await pool.addAccount(makeMockAccount({
        id: 'codearts-on',
        provider: 'codearts',
        enabled: true,
        credentialRef: 'CA_ON',
        modelRateLimits: { 'deepseek-v4-flash': Date.now() + 3_600_000 },
      }))

      expect((await pool.getAvailableAccount('codearts', ''))?.entry.id).toBe('codearts-on')
      expect(await pool.getAvailableAccount('codearts', 'deepseek-v4-flash')).toBeNull()
    })
  })

  // ── 限流标记清除（重测/重置的底层能力）──
  describe('clearModelRateLimits', () => {
    it('清空后删除 modelRateLimits 字段本身，不留空对象', async () => {
      await pool.addAccount(makeMockAccount({
        modelRateLimits: { 'deepseek-v4-flash': Date.now() + 1000 },
      }))
      const removed = await pool.clearModelRateLimits('buddy-001')
      expect(removed).toBe(1)
      expect((await pool.listAccounts('buddy'))[0].modelRateLimits).toBeUndefined()
    })

    it('只清除指定的模型，其余保留', async () => {
      const keep = Date.now() + 3_600_000
      await pool.addAccount(makeMockAccount({
        modelRateLimits: { 'model-a': Date.now() + 1000, 'model-b': keep },
      }))
      const removed = await pool.clearModelRateLimits('buddy-001', ['model-a'])
      expect(removed).toBe(1)
      expect((await pool.listAccounts('buddy'))[0].modelRateLimits).toEqual({ 'model-b': keep })
    })

    it('对无标记的账号返回 0 且不写盘', async () => {
      await pool.addAccount(makeMockAccount())
      expect(await pool.clearModelRateLimits('buddy-001')).toBe(0)
    })

    it('对不存在的账号返回 0', async () => {
      expect(await pool.clearModelRateLimits('nonexistent')).toBe(0)
    })
  })

  describe('resolveCredentialForAccount（含停用账号）', () => {
    it('停用账号凭据仍可按 id 解析（重测需要）', async () => {
      await ctx.credentials.set(credentialRef('CA_OFF'), JSON.stringify({ access_key_id: 'off' }))
      await pool.addAccount(makeMockAccount({
        id: 'codearts-off', provider: 'codearts', enabled: false, credentialRef: 'CA_OFF',
      }))

      const credential = await pool.resolveCredentialForAccount('codearts-off')
      expect(credential).toMatchObject({ access_key_id: 'off' })
      // 但自动选择必须仍然排除它
      expect(await pool.getAvailableAccount('codearts', '')).toBeNull()
    })

    it('账号不存在或凭据不可用时返回 undefined', async () => {
      expect(await pool.resolveCredentialForAccount('missing')).toBeUndefined()
      await pool.addAccount(makeMockAccount())  // 未设置凭据
      expect(await pool.resolveCredentialForAccount('buddy-001')).toBeUndefined()
    })
  })

  it('listAccountsByProvider 含停用账号', async () => {
    await pool.addAccount(makeMockAccount({ id: 'on', enabled: true }))
    await pool.addAccount(makeMockAccount({ id: 'off', enabled: false, credentialRef: 'BUDDY_ACCOUNT_T2' }))
    await pool.addAccount(makeMockAccount({ id: 'ca', provider: 'codearts', credentialRef: 'CODEARTS_ACCOUNT_C1' }))

    expect(pool.listAccountsByProvider('buddy').map(a => a.id).sort()).toEqual(['off', 'on'])
    expect(pool.findAccount('off')?.enabled).toBe(false)
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

  /**
   * 回归：settings scope 的 get() 滞后于 replace() 时，连续记录多个账号的
   * 限流不能互相覆盖。
   *
   * 曾经的实现每次都以 scope.get() 为读源，若快照滞后，第二次写入会基于
   * 不含第一次记录的旧快照整体 replace，把前一条限流抹掉——表现为
   * "多个账号都触发过限流，settings.yaml 里却一条 modelRateLimits 都没有"。
   */
  it('keeps earlier rate limits when recording several accounts under a stale scope', async () => {
    const staleCtx = createMockContext([], { staleReads: true })
    const stalePool = new AccountPool(staleCtx as never)

    await stalePool.addAccount(makeMockAccount({ id: 'acct-1', credentialRef: 'BUDDY_ACCOUNT_T1' }))
    await stalePool.addAccount(makeMockAccount({ id: 'acct-2', credentialRef: 'BUDDY_ACCOUNT_T2' }))
    await stalePool.addAccount(makeMockAccount({ id: 'acct-3', credentialRef: 'BUDDY_ACCOUNT_T3' }))

    const t1 = Date.now() + 3_600_000
    const t2 = Date.now() + 7_200_000
    const t3 = Date.now() + 10_800_000
    await stalePool.updateModelRateLimit('acct-1', 'deepseek-v4.1-flash', t1)
    await stalePool.updateModelRateLimit('acct-2', 'deepseek-v4.1-flash', t2)
    await stalePool.updateModelRateLimit('acct-3', 'deepseek-v4.1-flash', t3)

    const list = await stalePool.listAllAccounts()
    const limits = list.map(a => a.modelRateLimits?.['deepseek-v4.1-flash'])
    // 三条记录都必须留存（fix 前这里会是 [undefined, undefined, t3] 或类似）
    expect(limits).toEqual([t1, t2, t3])
  })
})

describe('findAccountIdByCredential 的 provider 字段选择', () => {
  it('workbuddy 按 access_token 匹配', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await ctx.credentials.set(credentialRef('WORKBUDDY_ACCOUNT_T1'), JSON.stringify({
      access_token: 'WB-TOKEN', refresh_token: 'RT', expires_at: String(Date.now() + 3_600_000),
    }))
    await pool.addAccount({
      id: 'workbuddy-1', provider: 'workbuddy', nickname: 'WB', enabled: true,
      credentialRef: 'WORKBUDDY_ACCOUNT_T1', createdAt: Date.now(), refreshable: true,
    })
    expect(await pool.findAccountIdByCredential('workbuddy', 'WB-TOKEN')).toBe('workbuddy-1')
  })

  it('workbuddy 不会误用 access_key_id 匹配', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await ctx.credentials.set(credentialRef('WORKBUDDY_ACCOUNT_T2'), JSON.stringify({
      access_token: 'WB-TOKEN', access_key_id: 'SOMETHING-ELSE', refresh_token: 'RT',
      expires_at: String(Date.now() + 3_600_000),
    }))
    await pool.addAccount({
      id: 'workbuddy-2', provider: 'workbuddy', nickname: 'WB', enabled: true,
      credentialRef: 'WORKBUDDY_ACCOUNT_T2', createdAt: Date.now(), refreshable: true,
    })
    // 传入 access_token 值应命中
    expect(await pool.findAccountIdByCredential('workbuddy', 'WB-TOKEN')).toBe('workbuddy-2')
    // 传入 access_key_id 值不应命中（说明用的确实是 access_token 字段）
    expect(await pool.findAccountIdByCredential('workbuddy', 'SOMETHING-ELSE')).toBe('')
  })

  it('codearts 仍按 access_key_id 匹配（既有行为不回归）', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await ctx.credentials.set(credentialRef('CODEARTS_ACCOUNT_T3'), JSON.stringify({
      access_key_id: 'AK-1', secret_access_key: 'SK', security_token: 'ST',
      expires_at: '2026-12-31T00:00:00Z',
    }))
    await pool.addAccount({
      id: 'codearts-1', provider: 'codearts', nickname: 'CA', enabled: true,
      credentialRef: 'CODEARTS_ACCOUNT_T3', createdAt: Date.now(), refreshable: true,
    })
    expect(await pool.findAccountIdByCredential('codearts', 'AK-1')).toBe('codearts-1')
  })

  it('buddy 仍按 access_token 匹配（既有行为不回归）', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_T4'), JSON.stringify({
      access_token: 'BD-TOKEN', refresh_token: 'RT', expires_at: String(Date.now() + 3_600_000),
    }))
    await pool.addAccount({
      id: 'buddy-4', provider: 'buddy', nickname: 'BD', enabled: true,
      credentialRef: 'BUDDY_ACCOUNT_T4', createdAt: Date.now(), refreshable: true,
    })
    expect(await pool.findAccountIdByCredential('buddy', 'BD-TOKEN')).toBe('buddy-4')
  })
})

describe('pruneAccountsWithForeignDomain', () => {
  /** WorkBuddy 国际版的判定目标：域名是 www.workbuddy.ai */
  const product = { id: 'workbuddy', apiDomain: 'www.workbuddy.ai' } as never

  it('删除 domain 指向旧端点（中国版）的 WorkBuddy 账号', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await ctx.credentials.set(credentialRef('WORKBUDDY_ACCOUNT_OLD'), JSON.stringify({
      access_token: 'AT', refresh_token: 'RT',
      expires_at: String(Date.now() + 3_600_000),
      domain: 'copilot.tencent.com',
    }))
    await pool.addAccount({
      id: 'workbuddy-old', provider: 'workbuddy', nickname: '旧', enabled: true,
      credentialRef: 'WORKBUDDY_ACCOUNT_OLD', createdAt: Date.now(), refreshable: true,
    })

    const removed = await pool.pruneAccountsWithForeignDomain(product)

    expect(removed).toEqual(['workbuddy-old'])
    expect(await pool.listAllAccounts()).toHaveLength(0)
  })

  it('保留 domain 与新端点一致的 WorkBuddy 账号', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await ctx.credentials.set(credentialRef('WORKBUDDY_ACCOUNT_NEW'), JSON.stringify({
      access_token: 'AT', refresh_token: 'RT',
      expires_at: String(Date.now() + 3_600_000),
      domain: 'www.workbuddy.ai',
    }))
    await pool.addAccount({
      id: 'workbuddy-new', provider: 'workbuddy', nickname: '新', enabled: true,
      credentialRef: 'WORKBUDDY_ACCOUNT_NEW', createdAt: Date.now(), refreshable: true,
    })

    const removed = await pool.pruneAccountsWithForeignDomain(product)

    expect(removed).toEqual([])
    expect(await pool.listAllAccounts()).toHaveLength(1)
  })

  it('不触碰其他 provider 的账号', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    // CodeBuddy 账号的 domain 也是 copilot.tencent.com，但不该被 WorkBuddy 的清理波及
    await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_KEEP'), JSON.stringify({
      access_token: 'AT', refresh_token: 'RT',
      expires_at: String(Date.now() + 3_600_000),
      domain: 'copilot.tencent.com',
    }))
    await pool.addAccount({
      id: 'buddy-keep', provider: 'buddy', nickname: 'CB', enabled: true,
      credentialRef: 'BUDDY_ACCOUNT_KEEP', createdAt: Date.now(), refreshable: true,
    })

    const removed = await pool.pruneAccountsWithForeignDomain(product)

    expect(removed).toEqual([])
    expect(await pool.listAllAccounts()).toHaveLength(1)
  })

  it('domain 为空的历史凭据保守保留（无法判定）', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await ctx.credentials.set(credentialRef('WORKBUDDY_ACCOUNT_NODOMAIN'), JSON.stringify({
      access_token: 'AT', refresh_token: 'RT',
      expires_at: String(Date.now() + 3_600_000),
      domain: '',
    }))
    await pool.addAccount({
      id: 'workbuddy-nodomain', provider: 'workbuddy', nickname: '?', enabled: true,
      credentialRef: 'WORKBUDDY_ACCOUNT_NODOMAIN', createdAt: Date.now(), refreshable: true,
    })

    const removed = await pool.pruneAccountsWithForeignDomain(product)

    expect(removed).toEqual([])
    expect(await pool.listAllAccounts()).toHaveLength(1)
  })

  it('凭据缺失时不删除（交给正常的「凭据未配置」报错路径）', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await pool.addAccount({
      id: 'workbuddy-nocred', provider: 'workbuddy', nickname: '无', enabled: true,
      credentialRef: 'WORKBUDDY_ACCOUNT_MISSING', createdAt: Date.now(), refreshable: true,
    })

    const removed = await pool.pruneAccountsWithForeignDomain(product)

    expect(removed).toEqual([])
    expect(await pool.listAllAccounts()).toHaveLength(1)
  })

  it('凭据 JSON 损坏时不删除且不抛异常', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await ctx.credentials.set(credentialRef('WORKBUDDY_ACCOUNT_BROKEN'), '{not json')
    await pool.addAccount({
      id: 'workbuddy-broken', provider: 'workbuddy', nickname: '坏', enabled: true,
      credentialRef: 'WORKBUDDY_ACCOUNT_BROKEN', createdAt: Date.now(), refreshable: true,
    })

    const removed = await pool.pruneAccountsWithForeignDomain(product)

    expect(removed).toEqual([])
    expect(await pool.listAllAccounts()).toHaveLength(1)
  })

  it('混合场景：只删失配的，保留其余', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    for (const [ref, domain] of [
      ['WORKBUDDY_ACCOUNT_A', 'copilot.tencent.com'],
      ['WORKBUDDY_ACCOUNT_B', 'www.workbuddy.ai'],
      ['WORKBUDDY_ACCOUNT_C', 'copilot.tencent.com'],
    ] as const) {
      await ctx.credentials.set(credentialRef(ref), JSON.stringify({
        access_token: 'AT', refresh_token: 'RT',
        expires_at: String(Date.now() + 3_600_000), domain,
      }))
      await pool.addAccount({
        id: ref.toLowerCase(), provider: 'workbuddy', nickname: ref, enabled: true,
        credentialRef: ref, createdAt: Date.now(), refreshable: true,
      })
    }

    const removed = await pool.pruneAccountsWithForeignDomain(product)

    expect(removed.sort()).toEqual(['workbuddy_account_a', 'workbuddy_account_c'])
    const left = await pool.listAllAccounts()
    expect(left).toHaveLength(1)
    expect(left[0]!.id).toBe('workbuddy_account_b')
  })
})
