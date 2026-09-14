/**
 * 遗留缺陷回归测试：`account-probe` 的适配器选择必须按**产品配置**判定。
 *
 * 原始实现只判断 `entry.provider === 'buddy'`，于是 `workbuddy` 账号落入
 * else 分支、被交给 `CodeArtsAdapter`（华为云 HMAC 签名 + 错误端点）去发
 * WorkBuddy 凭据，探测必然失败。本文件用被 mock 的 BuddyAdapter 验证：
 * buddy 与 workbuddy 都走 BuddyAdapter，且各自带上自己的 product 配置。
 *
 * 注意：BuddyAdapter 被替换为桩（不发任何网络请求），CodeArtsAdapter 保持
 * 真实但**在本文件内不会被构造** —— 若缺陷复发，workbuddy 分支会构造真实
 * CodeArtsAdapter 并发起网络请求，测试随即失败。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ProbePool } from '../../src/account-probe.js'
import type { ProviderAccountEntry } from '../../src/types.js'

vi.mock('../../src/buddy-adapter.js', () => {
  /** 记录被构造的选项；流式请求一律以限流错误结束（不发网络请求）。 */
  class MockBuddyAdapter {
    static readonly instances: Array<{ product?: { id: string; productCode: string } }> = []
    constructor(options: { product?: { id: string; productCode: string } }) {
      MockBuddyAdapter.instances.push(options)
    }
    // eslint-disable-next-line require-yield
    async *stream(): AsyncGenerator<never> {
      throw new LlmError('频率限制', 'RATE_LIMIT')
    }
  }
  return { BuddyAdapter: MockBuddyAdapter }
})

/** 取 mock 的构造记录。 */
async function adapterInstances(): Promise<Array<{ product?: { id: string; productCode: string } }>> {
  const mod = await import('../../src/buddy-adapter.js') as unknown as {
    BuddyAdapter: { instances: Array<{ product?: { id: string; productCode: string } }> }
  }
  return mod.BuddyAdapter.instances
}

function makeEntry(overrides: Partial<ProviderAccountEntry>): ProviderAccountEntry {
  return {
    id: 'wb-1',
    provider: 'workbuddy',
    nickname: '测试号',
    enabled: true,
    credentialRef: 'WORKBUDDY_ACCOUNT_TEST',
    createdAt: 1,
    refreshable: true,
    modelRateLimits: { 'deepseek-v4.1-flash': Date.now() + 3_600_000 },
    ...overrides,
  }
}

/** 只实现探测路径用到的方法。 */
function makePool(entries: ProviderAccountEntry[]): ProbePool {
  const accounts = new Map(entries.map(e => [e.id, e]))
  return {
    findAccount: (id) => accounts.get(id),
    listAccountsByProvider: (provider) => [...accounts.values()].filter(a => a.provider === provider),
    async resolveCredentialForAccount() {
      return { access_token: 'AT', refresh_token: 'RT', expires_at: '2099-01-01T00:00:00Z' }
    },
    async clearModelRateLimits() { return 0 },
  }
}

describe('account-probe 适配器选择按产品判定', () => {
  beforeEach(async () => {
    ;(await adapterInstances()).length = 0
  })

  it('workbuddy 账号走 BuddyAdapter 并携带 WorkBuddy 产品配置', async () => {
    const { retestAccount } = await import('../../src/account-probe.js')
    const result = await retestAccount(makePool([makeEntry({})]), 'wb-1')

    // 仍受限（桩抛限流错误），但关键在于是**由 BuddyAdapter** 发起的
    expect(result.tested).toBe(1)
    expect(result.stillLimited).toHaveLength(1)

    const instances = await adapterInstances()
    expect(instances).toHaveLength(1)
    expect(instances[0]?.product?.id).toBe('workbuddy')
    expect(instances[0]?.product?.productCode).toBe('workbuddy')
  })

  it('buddy 账号仍走 BuddyAdapter 且携带 CodeBuddy 产品配置', async () => {
    const { retestAccount } = await import('../../src/account-probe.js')
    await retestAccount(makePool([makeEntry({
      id: 'buddy-1',
      provider: 'buddy',
      credentialRef: 'BUDDY_ACCOUNT_TEST',
    })]), 'buddy-1')

    const instances = await adapterInstances()
    expect(instances).toHaveLength(1)
    expect(instances[0]?.product?.id).toBe('buddy')
    expect(instances[0]?.product?.productCode).toBe('codebuddy')
  })
})
