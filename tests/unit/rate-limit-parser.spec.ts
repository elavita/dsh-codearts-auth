import { describe, it, expect } from 'vitest'
import { isRateLimited, parseRateLimitError } from '../../src/llm-adapter.js'

describe('rate limit parser', () => {
  it('should detect rate limit error', () => {
    const body = '{"code":6004,"msg":"您的使用量已超出频率限制，将在 2026-09-11 18:08:17 UTC+8 重置，您也可以切换其他模型继续使用。","requestId":"xyz"}'
    expect(isRateLimited(body)).toBe(true)
  })

  it('should not detect normal error', () => {
    const body = '{"error":{"message":"model not found"}}'
    expect(isRateLimited(body)).toBe(false)
  })

  it('should parse reset time from buddy error', () => {
    const body = '{"code":6004,"msg":"您的使用量已超出频率限制，将在 2026-09-11 18:08:17 UTC+8 重置，您也可以切换其他模型继续使用。","requestId":"xyz"}'
    const result = parseRateLimitError(body, 'deepseek-v4-flash')
    expect(result).not.toBeNull()
    expect(result!.modelId).toBe('deepseek-v4-flash')
    // 验证解析的时间戳大致正确
    const expected = Date.parse('2026-09-11 18:08:17 UTC+8')
    expect(result!.resetTimeMs).toBe(expected)
  })

  // ── WorkBuddy 国际版（英文报文）回归 ──
  //
  // 线上实测报文，逐字取自用户上报的 6004 响应体。早期判定正则只有中文
  // 关键词 + `rate.?limit`，而该报文既无中文也不含 `rate limit` 字面量
  // （它是 `frequency limit`），导致 isRateLimited 恒为 false、账号池
  // 切换分支整体不进入。以下用例锁死该回归。

  /** WorkBuddy 国际版的 6004 报文（逐字取自线上）。 */
  const WORKBUDDY_EN_BODY = '{"code":6004,"msg":"usage exceeds frequency limit, but don\'t worry, your usage will reset at 2026-09-21 09:45:56 UTC+8, alternatively, you can switch to the other models to continue using it.","requestId":"505ba860-7f8b-43a2-8e19-fe13ec045a2c"}'

  it('should detect WorkBuddy international (English) rate limit error', () => {
    expect(isRateLimited(WORKBUDDY_EN_BODY)).toBe(true)
  })

  it('should parse reset time from WorkBuddy international error', () => {
    const result = parseRateLimitError(WORKBUDDY_EN_BODY, 'deepseek-v4.1-flash')
    expect(result).not.toBeNull()
    expect(result!.modelId).toBe('deepseek-v4.1-flash')
    // 必须解析出报文里的真实重置时间，而不是回退成「1 小时后」
    expect(result!.resetTimeMs).toBe(Date.parse('2026-09-21 09:45:56 UTC+8'))
  })

  it('should detect rate limit by code even when message has no keywords', () => {
    // code 是比任何文本正则都稳定的信号：措辞再变也应认出限流。
    expect(isRateLimited('{"code":6004,"msg":"quota exhausted"}')).toBe(true)
  })

  it('should not detect normal JSON error as rate limit', () => {
    expect(isRateLimited('{"code":10001,"msg":"already checked in today"}')).toBe(false)
  })

  it('should honor non-UTC+8 offsets in reset time', () => {
    const body = '{"code":6004,"msg":"your usage will reset at 2026-09-21 09:45:56 UTC-5"}'
    const result = parseRateLimitError(body, 'm')
    expect(result!.resetTimeMs).toBe(Date.parse('2026-09-21 09:45:56 UTC-5'))
  })

  it('should fall back to one hour ahead when reset time is absent', () => {
    // 标准 OpenAI 429 格式：认得出限流，但报文里没有重置时间。
    const before = Date.now()
    const result = parseRateLimitError('{"error":{"message":"rate limit exceeded"}}', 'm')
    expect(result).not.toBeNull()
    expect(result!.resetTimeMs).toBeGreaterThanOrEqual(before + 3_600_000)
  })
})
