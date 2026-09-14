import { describe, expect, it, vi } from 'vitest'
import { CHECKIN_ACTIVITY_STATUS_PATH, DAILY_CHECKIN_PATH, claimDailyCheckin, fetchCheckinStatus } from '../../src/credits.js'
import { WORKBUDDY } from '../../src/product.js'
import type { BuddyCredential } from '../../src/buddy.js'

function makeCredential(): BuddyCredential {
  return {
    access_token: 'AT', refresh_token: 'RT',
    expires_at: String(Date.now() + 3_600_000),
    token_type: 'Bearer', scope: '', domain: 'copilot.tencent.com',
    user_id: 'uid-1',
  }
}

/** 构造按规则应答的桩 fetch。 */
function stubFetch(responder: (url: string) => Response): typeof fetch {
  return vi.fn(async (url: unknown) => responder(String(url))) as unknown as typeof fetch
}

describe('积分签到模块', () => {
  it('使用正确的端点路径', () => {
    expect(CHECKIN_ACTIVITY_STATUS_PATH).toBe('/v2/billing/meter/checkin-activity-status')
    expect(DAILY_CHECKIN_PATH).toBe('/v2/billing/meter/daily-checkin')
  })

  it('fetchCheckinStatus 解析活动状态', async () => {
    const fetcher = stubFetch(() => new Response(JSON.stringify({
      code: 0, msg: 'OK',
      data: {
        active: true, today_checked_in: false, streak_days: 3, daily_credit: 100,
        today_credit: 0, is_streak_day: false, total_credits: 300,
        checkin_dates: ['2026-09-12', '2026-09-13'], activity_name: '开学季',
        theme_name: 'Buddy加油站', end_time: '2026-09-15 23:59:59',
      },
    }), { status: 200 }))
    const status = await fetchCheckinStatus(makeCredential(), WORKBUDDY, fetcher)
    expect(status).toEqual({
      active: true, todayCheckedIn: false, streakDays: 3, dailyCredit: 100,
      todayCredit: 0, isStreakDay: false, totalCredits: 300,
      checkinDates: ['2026-09-12', '2026-09-13'], activityName: '开学季',
      themeName: 'Buddy加油站', endTime: '2026-09-15 23:59:59',
    })
  })

  it('fetchCheckinStatus 对缺失字段容错（不抛异常，取默认值）', async () => {
    const fetcher = stubFetch(() => new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 }))
    const status = await fetchCheckinStatus(makeCredential(), WORKBUDDY, fetcher)
    expect(status).toEqual({
      active: false, todayCheckedIn: false, streakDays: 0, dailyCredit: 0,
      todayCredit: 0, isStreakDay: false, totalCredits: 0,
      checkinDates: [], activityName: '', themeName: '', endTime: '',
    })
  })

  it('fetchCheckinStatus 在网络失败时返回 null', async () => {
    const fetcher = vi.fn(async () => { throw new Error('network down') }) as unknown as typeof fetch
    expect(await fetchCheckinStatus(makeCredential(), WORKBUDDY, fetcher)).toBeNull()
  })

  it('fetchCheckinStatus 在非 0 code 时返回 null', async () => {
    const fetcher = stubFetch(() => new Response(JSON.stringify({ code: 500, msg: 'boom' }), { status: 200 }))
    expect(await fetchCheckinStatus(makeCredential(), WORKBUDDY, fetcher)).toBeNull()
  })

  it('claimDailyCheckin 成功时返回 claimed 与领取数额', async () => {
    const fetcher = stubFetch(() => new Response(JSON.stringify({
      code: 0, msg: 'OK', data: { credit: 100, streak_days: 1, is_streak_day: false },
    }), { status: 200 }))
    expect(await claimDailyCheckin(makeCredential(), WORKBUDDY, fetcher)).toEqual({
      kind: 'claimed', credit: 100, streakDays: 1, isStreakDay: false,
    })
  })

  it('claimDailyCheckin 对 code 10001 返回 already-claimed（幂等，非错误）', async () => {
    const fetcher = stubFetch(() => new Response(JSON.stringify({
      code: 10001, msg: '今天已签到，请明天再来',
    }), { status: 400 }))
    const outcome = await claimDailyCheckin(makeCredential(), WORKBUDDY, fetcher)
    expect(outcome.kind).toBe('already-claimed')
    expect(outcome).toMatchObject({ message: '今天已签到，请明天再来' })
  })

  it('claimDailyCheckin 对 code 1001/1002/1003 同样视为非致命', async () => {
    for (const [code, expected] of [[1001, 'already-claimed'], [1002, 'inactive'], [1003, 'inactive']] as const) {
      const fetcher = stubFetch(() => new Response(JSON.stringify({ code, msg: `err ${code}` }), { status: 400 }))
      const outcome = await claimDailyCheckin(makeCredential(), WORKBUDDY, fetcher)
      expect(outcome.kind).toBe(expected)
    }
  })

  it('claimDailyCheckin 对其他错误返回 failed 并保留 code 与消息', async () => {
    const fetcher = stubFetch(() => new Response(JSON.stringify({ code: 500, msg: '服务器错误' }), { status: 500 }))
    expect(await claimDailyCheckin(makeCredential(), WORKBUDDY, fetcher)).toEqual({
      kind: 'failed', code: 500, message: '服务器错误',
    })
  })

  it('claimDailyCheckin 在网络异常时返回 failed', async () => {
    const fetcher = vi.fn(async () => { throw new Error('socket hang up') }) as unknown as typeof fetch
    const outcome = await claimDailyCheckin(makeCredential(), WORKBUDDY, fetcher)
    expect(outcome.kind).toBe('failed')
    expect(outcome).toMatchObject({ message: expect.stringContaining('socket hang up') })
  })

  it('请求携带产品码与 bearer 凭据，且不携带 X-Device-Token', async () => {
    let seen: Headers | undefined
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      seen = init?.headers as Headers
      return new Response(JSON.stringify({ code: 0, data: { credit: 100, streak_days: 1, is_streak_day: false } }), { status: 200 })
    }) as unknown as typeof fetch
    await claimDailyCheckin(makeCredential(), WORKBUDDY, fetcher)
    expect(seen?.get('Authorization')).toBe('Bearer AT')
    expect(seen?.get('X-Product-Code')).toBe('workbuddy')
    expect(seen?.get('X-User-Id')).toBe('uid-1')
    // 实测证明该风控头非必需，实现不依赖本地图灵盾 SDK
    expect(seen?.get('X-Device-Token')).toBeNull()
  })

  it('请求方法为 POST 且 body 为 {}', async () => {
    let method = ''
    let body: unknown
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      method = init?.method ?? ''
      body = init?.body
      return new Response(JSON.stringify({ code: 0, data: { credit: 1, streak_days: 1, is_streak_day: false } }), { status: 200 })
    }) as unknown as typeof fetch
    await claimDailyCheckin(makeCredential(), WORKBUDDY, fetcher)
    expect(method).toBe('POST')
    expect(body).toBe('{}')
  })
})
