import { describe, expect, it } from 'vitest'
import {
  buildCredential,
  credentialAuthHeaders,
  credentialExpiresAtMs,
  credentialRequestHeaders,
  displayNameForModel,
  isExpired,
  isRefreshable,
  parseAccountData,
  parseModelsFromConfig,
  parseTokenData,
} from '../../src/buddy.js'

const futureMs = Date.now() + 7_200_000
const pastMs = Date.now() - 60_000

describe('buddy credential parsing', () => {
  it('parseTokenData accepts string fields and defaults tokenType to Bearer', () => {
    const token = parseTokenData({
      accessToken: 'AT',
      refreshToken: 'RT',
      expiresAt: '2026-08-30T00:00:00Z',
      refreshExpiresAt: '2026-09-29T00:00:00Z',
      scope: '',
      domain: 'copilot.tencent.com',
    })
    expect(token).toEqual({
      accessToken: 'AT',
      refreshToken: 'RT',
      expiresAt: '2026-08-30T00:00:00Z',
      refreshExpiresAt: '2026-09-29T00:00:00Z',
      tokenType: 'Bearer',
      scope: '',
      domain: 'copilot.tencent.com',
    })
  })

  it('parseTokenData stringifies numeric timestamps', () => {
    const token = parseTokenData({ accessToken: 'AT', refreshToken: 'RT', expiresAt: futureMs })
    expect(token.expiresAt).toBe(String(futureMs))
  })

  it('parseTokenData tolerates null/non-object payloads', () => {
    expect(parseTokenData(null).accessToken).toBe('')
    expect(parseTokenData(undefined).tokenType).toBe('Bearer')
  })

  it('parseAccountData defaults type to personal', () => {
    const account = parseAccountData({ uid: 'u1', nickname: 'n1', enterpriseId: '' })
    expect(account).toEqual({ uid: 'u1', nickname: 'n1', enterpriseId: '', accountType: 'personal' })
  })

  it('buildCredential merges token and account', () => {
    const credential = buildCredential(
      parseTokenData({ accessToken: 'AT', refreshToken: 'RT', domain: 'copilot.tencent.com' }),
      parseAccountData({ uid: 'u1', nickname: 'n1', type: 'enterprise', enterpriseId: 'ent-1' }),
    )
    expect(credential).toMatchObject({
      access_token: 'AT',
      refresh_token: 'RT',
      domain: 'copilot.tencent.com',
      user_id: 'u1',
      nickname: 'n1',
      account_type: 'enterprise',
      enterprise_id: 'ent-1',
    })
  })
})

describe('buddy expiry helpers', () => {
  it('credentialExpiresAtMs reads millisecond timestamps', () => {
    expect(credentialExpiresAtMs({ access_token: 'AT', refresh_token: 'RT', expires_at: String(futureMs) })).toBe(futureMs)
  })

  it('credentialExpiresAtMs converts second timestamps to milliseconds', () => {
    const seconds = Math.floor(futureMs / 1000)
    expect(credentialExpiresAtMs({ access_token: 'AT', refresh_token: 'RT', expires_at: String(seconds) })).toBe(seconds * 1000)
  })

  it('credentialExpiresAtMs parses ISO 8601 strings', () => {
    expect(credentialExpiresAtMs({ access_token: 'AT', refresh_token: 'RT', expires_at: '2026-08-30T00:00:00Z' }))
      .toBe(Date.parse('2026-08-30T00:00:00Z'))
  })

  it('credentialExpiresAtMs returns undefined when absent or unparseable', () => {
    expect(credentialExpiresAtMs({ access_token: 'AT', refresh_token: 'RT' })).toBeUndefined()
    expect(credentialExpiresAtMs({ access_token: 'AT', refresh_token: 'RT', expires_at: 'not-a-date' })).toBeUndefined()
  })

  it('isExpired is false when the expiry is unknown (aligns with Rust is_expired)', () => {
    expect(isExpired({ access_token: 'AT', refresh_token: 'RT' })).toBe(false)
    expect(isExpired({ access_token: 'AT', refresh_token: 'RT', expires_at: String(futureMs) })).toBe(false)
    expect(isExpired({ access_token: 'AT', refresh_token: 'RT', expires_at: String(pastMs) })).toBe(true)
  })

  it('isRefreshable requires a non-empty refresh_token', () => {
    expect(isRefreshable({ access_token: 'AT', refresh_token: 'RT' })).toBe(true)
    expect(isRefreshable({ access_token: 'AT', refresh_token: '' })).toBe(false)
  })
})

describe('buddy request headers', () => {
  it('requestHeaders sends X-Domain and the IDE User-Agent', () => {
    const headers = credentialRequestHeaders({ access_token: 'AT', refresh_token: 'RT', domain: 'copilot.tencent.com' })
    expect(headers['X-Domain']).toBe('copilot.tencent.com')
    expect(headers['User-Agent']).toBe('CodeBuddyIDE/1.106.1')
  })

  it('requestHeaders falls back to the default domain', () => {
    expect(credentialRequestHeaders({ access_token: 'AT', refresh_token: 'RT' })['X-Domain']).toBe('copilot.tencent.com')
  })

  it('requestHeaders adds enterprise headers only for enterprise accounts', () => {
    const personal = credentialRequestHeaders({ access_token: 'AT', refresh_token: 'RT', enterprise_id: '' })
    expect(personal['X-Enterprise-Id']).toBeUndefined()

    const enterprise = credentialRequestHeaders({ access_token: 'AT', refresh_token: 'RT', enterprise_id: 'ent-123' })
    expect(enterprise['X-Enterprise-Id']).toBe('ent-123')
    expect(enterprise['X-Tenant-Id']).toBe('ent-123')
  })

  it('authHeaders adds the Bearer token', () => {
    const headers = credentialAuthHeaders({ access_token: 'tok', refresh_token: 'RT', domain: 'copilot.tencent.com' })
    expect(headers.Authorization).toBe('Bearer tok')
    expect(headers['X-Domain']).toBe('copilot.tencent.com')
  })
})

describe('buddy model config parsing', () => {
  it('parses craft agent models and excludes auto', () => {
    const models = parseModelsFromConfig({
      data: {
        agents: [
          { name: 'other', models: ['should-be-ignored'] },
          { name: 'craft', models: ['auto', 'hy4-preview', 'glm-5.3'] },
        ],
      },
    })
    expect(models).toEqual([
      { id: 'hy4-preview', name: 'Hy4 Preview' },
      { id: 'glm-5.3', name: 'GLM-5.3' },
    ])
  })

  it('returns an empty list for malformed payloads', () => {
    expect(parseModelsFromConfig(null)).toEqual([])
    expect(parseModelsFromConfig({})).toEqual([])
    expect(parseModelsFromConfig({ data: {} })).toEqual([])
    expect(parseModelsFromConfig({ data: { agents: [{ name: 'craft' }] } })).toEqual([])
    expect(parseModelsFromConfig({ data: { agents: [{ name: 'nope', models: ['a'] }] } })).toEqual([])
  })

  it('displayNameForModel falls back to the raw id', () => {
    expect(displayNameForModel('deepseek-v4-flash')).toBe('DeepSeek V4 Flash')
    expect(displayNameForModel('some-unknown-model')).toBe('some-unknown-model')
  })
})
