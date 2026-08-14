import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeRefreshDelayMs, REFRESH_LEAD_MS, RefreshScheduler } from '../../src/refresh.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('computeRefreshDelayMs', () => {
  it('returns 0 when within the lead window and the delay otherwise', () => {
    const now = Date.parse('2026-08-14T12:00:00Z')
    expect(computeRefreshDelayMs(now + REFRESH_LEAD_MS - 1, now)).toBe(0)
    expect(computeRefreshDelayMs(now + REFRESH_LEAD_MS + 1000, now)).toBe(1000)
  })
})

describe('RefreshScheduler', () => {
  it('fires the refresh at the computed delay', async () => {
    vi.useFakeTimers()
    const refresh = vi.fn(async () => {})
    const scheduler = new RefreshScheduler(refresh)
    const now = Date.now()
    // 2 分钟后在 1 小时提前窗口内 → 延迟 0 → 立即触发。
    scheduler.arm(now + 120_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(1)
    scheduler.stop()
  })

  it('reports failures to onError and retries once', async () => {
    vi.useFakeTimers()
    const refresh = vi.fn(async () => { throw new Error('refresh failed') })
    const onError = vi.fn()
    const scheduler = new RefreshScheduler(refresh, onError)
    scheduler.arm(Date.now() - 1) // 已过提前窗口 → 立即触发
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(refresh).toHaveBeenCalledTimes(2)
    scheduler.stop()
  })
})
