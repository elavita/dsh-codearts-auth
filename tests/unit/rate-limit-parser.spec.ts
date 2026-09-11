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
})
