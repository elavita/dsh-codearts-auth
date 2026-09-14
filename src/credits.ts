/**
 * WorkBuddy 每日签到（领取积分）客户端。
 *
 * 端点与格式均来自对 WorkBuddy 5.5.6 的逆向 + 真实请求实测（2026-09-14）：
 *
 *   状态查询  POST /v2/billing/meter/checkin-activity-status   body {}
 *   领取      POST /v2/billing/meter/daily-checkin             body {}
 *
 * 两个关键结论（实测）：
 *
 * 1. **必须用 checkin-activity-status，不能用 checkin-status**。后者返回的
 *    是占位数据（active:false、checkin_dates:null、claim_button_text:""），
 *    会让人误判为"活动未开启"。前者才是权威状态源。
 *
 * 2. **不需要 X-Device-Token（图灵盾）**。静态分析曾认为该头是主要门槛，
 *    但实测三种请求头组合调用状态接口全部 200，且完全不带该头的请求真实
 *    领取成功（code:0, credit:100）并可见状态翻转。因此不引入 native SDK。
 *
 * 幂等：重复领取返回 HTTP 400 + code 10001（"今天已签到，请明天再来"）。
 * 判定以响应体 code 为准 —— 不能只看 HTTP 状态。
 */

import {
  BUDDY_DEPLOYMENT_TYPE,
  HTTP_HEADER_DOMAIN,
  HTTP_HEADER_PRODUCT,
  HTTP_HEADER_PRODUCT_CODE,
} from './buddy.js'
import type { BuddyCredential } from './buddy.js'
import type { BuddyProduct } from './product.js'

/** 签到状态查询端点（权威状态源）。 */
export const CHECKIN_ACTIVITY_STATUS_PATH = '/v2/billing/meter/checkin-activity-status'
/** 每日签到领取端点。 */
export const DAILY_CHECKIN_PATH = '/v2/billing/meter/daily-checkin'

/** 签到请求超时（毫秒）。 */
const REQUEST_TIMEOUT_MS = 30_000

/** 服务端返回的 "今日已签到" 业务码（实测值）。 */
const CODE_ALREADY_CLAIMED = 10001
/** 静态分析列出的备选码表：1001=已领取 1002=无资格 1003=活动结束。 */
const CODE_ALREADY_CLAIMED_ALT = 1001
const CODE_NO_QUALIFICATION = 1002
const CODE_ACTIVITY_ENDED = 1003

/** 签到活动状态（字段名已转为 camelCase）。 */
export interface CheckinStatus {
  /** 活动是否进行中。false 时不应尝试领取 */
  active: boolean
  /** 今日是否已签到 —— 领取判定的权威依据 */
  todayCheckedIn: boolean
  /** 连续签到天数 */
  streakDays: number
  /** 每日可领积分 */
  dailyCredit: number
  /** 今日已领积分 */
  todayCredit: number
  /** 今日是否为连续奖励日 */
  isStreakDay: boolean
  /** 累计已领积分 */
  totalCredits: number
  /** 已签到日期列表（如 ["2026-09-14"]） */
  checkinDates: string[]
  /** 活动名（如「开学季」） */
  activityName: string
  /** 主题名（如「Buddy加油站」） */
  themeName: string
  /** 活动结束时间 */
  endTime: string
}

/** 一次领取的结果。 */
export type ClaimOutcome =
  | { kind: 'claimed'; credit: number; streakDays: number; isStreakDay: boolean; delayedMessage?: string }
  | { kind: 'already-claimed'; message: string }
  | { kind: 'inactive'; message: string }
  | { kind: 'failed'; code: number; message: string }

/** 构造签到请求头。不含 X-Device-Token（实测非必需）。 */
function checkinHeaders(credential: BuddyCredential, product: BuddyProduct): Headers {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${credential.access_token}`)
  headers.set('Accept', 'application/json')
  headers.set('Content-Type', 'application/json')
  headers.set(HTTP_HEADER_DOMAIN, credential.domain ?? product.apiDomain)
  headers.set(HTTP_HEADER_PRODUCT, BUDDY_DEPLOYMENT_TYPE)
  headers.set(HTTP_HEADER_PRODUCT_CODE, product.productCode)
  if (credential.user_id !== undefined && credential.user_id.length > 0) {
    headers.set('X-User-Id', credential.user_id)
  }
  if (credential.enterprise_id !== undefined && credential.enterprise_id.length > 0) {
    headers.set('X-Enterprise-Id', credential.enterprise_id)
    headers.set('X-Tenant-Id', credential.enterprise_id)
  }
  headers.set('User-Agent', product.userAgent)
  return headers
}

/** 从 JSON 安全读取布尔值。 */
function readBool(source: Record<string, unknown>, key: string): boolean {
  return source[key] === true
}

/** 从 JSON 安全读取数字。 */
function readNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 从 JSON 安全读取字符串。 */
function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  return typeof value === 'string' ? value : ''
}

/** 从 JSON 安全读取字符串数组。 */
function readStringArray(source: Record<string, unknown>, key: string): string[] {
  const value = source[key]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/**
 * 一次签到请求的结果。
 *
 * 失败时保留**原因说明**而不是笼统的 undefined：网络异常时带上底层错误消息
 * （如 "socket hang up"），便于上层如实呈现失败原因，也便于排查。
 */
type PostResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; message: string }

/** 响应体可解析为对象、但缺少必要字段时的统一失败说明。 */
const UNPARSABLE_RESPONSE_MESSAGE = '请求失败或响应无法解析'

/**
 * 发起一次签到请求并解析 JSON 响应体。
 * 网络失败或响应无法解析为对象时返回失败原因（由调用方决定如何呈现）。
 */
async function postJson(
  path: string,
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch,
): Promise<PostResult> {
  try {
    const response = await fetcher(`${product.endpoint}${path}`, {
      method: 'POST',
      headers: checkinHeaders(credential, product),
      body: '{}',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const parsed = await response.json() as unknown
    if (typeof parsed !== 'object' || parsed === null) {
      return { ok: false, message: UNPARSABLE_RESPONSE_MESSAGE }
    }
    return { ok: true, body: parsed as Record<string, unknown> }
  } catch (error) {
    // 保留原始错误消息（含超时/连接被重置等信号），不吞掉诊断信息。
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 查询签到活动状态。
 * 使用 checkin-activity-status（权威源，非 checkin-status）。
 * 网络失败、响应非法或业务码非 0 时返回 null。
 */
export async function fetchCheckinStatus(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch = fetch,
): Promise<CheckinStatus | null> {
  const result = await postJson(CHECKIN_ACTIVITY_STATUS_PATH, credential, product, fetcher)
  if (!result.ok) return null
  const body = result.body
  if (body.code !== 0) return null
  const data = body.data
  if (typeof data !== 'object' || data === null) return null
  const record = data as Record<string, unknown>
  return {
    active: readBool(record, 'active'),
    todayCheckedIn: readBool(record, 'today_checked_in'),
    streakDays: readNumber(record, 'streak_days'),
    dailyCredit: readNumber(record, 'daily_credit'),
    todayCredit: readNumber(record, 'today_credit'),
    isStreakDay: readBool(record, 'is_streak_day'),
    totalCredits: readNumber(record, 'total_credits'),
    checkinDates: readStringArray(record, 'checkin_dates'),
    activityName: readString(record, 'activity_name'),
    themeName: readString(record, 'theme_name'),
    endTime: readString(record, 'end_time'),
  }
}

/**
 * 执行每日签到领取。
 *
 * 判定顺序：先看业务码是否属于「已领取 / 无资格 / 活动结束」这些非致命类别，
 * 再看是否成功，最后归为 failed。判定以响应体 code 为准（重复领取是 HTTP 400，
 * 只看状态码会把幂等情况误报为失败）。
 */
export async function claimDailyCheckin(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch = fetch,
): Promise<ClaimOutcome> {
  const result = await postJson(DAILY_CHECKIN_PATH, credential, product, fetcher)
  if (!result.ok) {
    return { kind: 'failed', code: -1, message: result.message }
  }
  const body = result.body
  const code = typeof body.code === 'number' ? body.code : -1
  const message = readString(body, 'msg')

  if (code === CODE_ALREADY_CLAIMED || code === CODE_ALREADY_CLAIMED_ALT) {
    return { kind: 'already-claimed', message: message.length > 0 ? message : '今天已签到' }
  }
  if (code === CODE_NO_QUALIFICATION || code === CODE_ACTIVITY_ENDED) {
    return { kind: 'inactive', message: message.length > 0 ? message : '当前无领取资格' }
  }
  if (code !== 0) {
    return { kind: 'failed', code, message: message.length > 0 ? message : '领取失败' }
  }
  const data = body.data
  if (typeof data !== 'object' || data === null) {
    return { kind: 'failed', code, message: '领取响应缺少 data 字段' }
  }
  const record = data as Record<string, unknown>
  const delayed = readString(record, 'message')
  return {
    kind: 'claimed',
    credit: readNumber(record, 'credit'),
    streakDays: readNumber(record, 'streak_days'),
    isStreakDay: readBool(record, 'is_streak_day'),
    ...delayed.length > 0 ? { delayedMessage: delayed } : {},
  }
}
