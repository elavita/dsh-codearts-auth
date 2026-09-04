import { describe, expect, it } from 'vitest'
import { fetchCodeArtsRemoteModels, OPENGW_GATEWAY_CONFIG_URL, SNAP_MODEL_BUILTIN_URL } from '../../src/models.js'
import type { CodeArtsCredential } from '../../src/types.js'

/** 构造一份最小可用凭据。 */
function makeCredential(): CodeArtsCredential {
  return {
    access_key_id: 'AKTEST',
    secret_access_key: 'SKTEST',
    security_token: 'STTEST',
    expires_at: '2026-12-31T00:00:00Z',
    refresh_token: 'rt',
    code_verifier: 'cv',
    dpop_private_key_jwk: 'jwk',
  } as CodeArtsCredential
}

/** 按 URL 路由返回不同响应的 mock fetch；记录每次请求的 URL 与头。 */
function makeFetcher(routes: Record<string, { status?: number; body: string }>) {
  const calls: Array<{ url: string; headers: Headers }> = []
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, headers: new Headers(init?.headers) })
    const route = routes[url]
    if (route === undefined) return new Response('', { status: 404 })
    return new Response(route.body, { status: route.status ?? 200 })
  }
  return { fetcher: fetcher as unknown as typeof fetch, calls }
}

describe('fetchCodeArtsRemoteModels', () => {
  it('requests the /v1/model/builtin endpoint (not the old statistics/plugin)', async () => {
    const { fetcher, calls } = makeFetcher({
      [SNAP_MODEL_BUILTIN_URL]: {
        body: JSON.stringify({
          count: 2,
          builtinModels: [
            { model_id: 'GLM-5.2', model_name: 'GLM-5.2' },
            { model_id: 'openpangu-2.0-flash', model_name: 'openpangu-2.0-flash' },
          ],
        }),
      },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const snapCall = calls.find((c) => c.url === SNAP_MODEL_BUILTIN_URL)
    expect(snapCall).toBeDefined()
    expect(models).toContainEqual({ id: 'GLM-5.2', name: 'GLM-5.2' })
    expect(models).toContainEqual({ id: 'openpangu-2.0-flash', name: 'openpangu-2.0-flash' })
  })

  it('sends Agent-Type: PromptCenter and X-Language: zh-cn on the builtin request (unsigned headers)', async () => {
    const { fetcher, calls } = makeFetcher({
      [SNAP_MODEL_BUILTIN_URL]: { body: JSON.stringify({ builtinModels: [] }) },
    })
    await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const snapCall = calls.find((c) => c.url === SNAP_MODEL_BUILTIN_URL)
    expect(snapCall?.headers.get('Agent-Type')).toBe('PromptCenter')
    expect(snapCall?.headers.get('X-Language')).toBe('zh-cn')
    expect(snapCall?.headers.get('Content-Type')).toBe('application/json')
  })

  it('parses builtinModels[] (not the old model_metrics field)', async () => {
    const { fetcher } = makeFetcher({
      [SNAP_MODEL_BUILTIN_URL]: {
        body: JSON.stringify({
          // 旧字段已废弃，不应被解析
          model_metrics: [{ model_id: 'OLD-SHOULD-NOT-APPEAR', model_name: 'old' }],
          builtinModels: [
            { model_id: 'GLM-5.2-ArkTS-SPARK', model_name: 'GLM-5.2 ArkTS SPARK' },
          ],
        }),
      },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    expect(models).toContainEqual({ id: 'GLM-5.2-ArkTS-SPARK', name: 'GLM-5.2 ArkTS SPARK' })
    expect(models.find((m) => m.id === 'OLD-SHOULD-NOT-APPEAR')).toBeUndefined()
  })

  it('filters out VL (vision) multimodal models from the builtin list', async () => {
    const { fetcher } = makeFetcher({
      [SNAP_MODEL_BUILTIN_URL]: {
        body: JSON.stringify({
          builtinModels: [
            { model_id: 'GLM-5.2', model_name: 'GLM-5.2' },
            { model_id: 'Qwen3-VL-235B', model_name: 'Qwen3-VL-235B' },
            { model_id: 'something-VL', model_name: 'something-VL' },
            { model_id: 'glm-5.2-sft-harmony', model_name: 'glm-5.2-sft-harmony' },
          ],
        }),
      },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const ids = models.map((m) => m.id)
    expect(ids).toContain('GLM-5.2')
    expect(ids).toContain('glm-5.2-sft-harmony')
    expect(ids).not.toContain('Qwen3-VL-235B')
    expect(ids).not.toContain('something-VL')
  })

  it('merges opengw gateway/config benefit models with builtin models, deduped', async () => {
    const { fetcher } = makeFetcher({
      [OPENGW_GATEWAY_CONFIG_URL]: {
        body: JSON.stringify({
          result: {
            models: [
              { model_id: 'glm-5.3-flash', model_name: 'glm-5.3-flash' },
              { model_id: 'deepseek-v4-flash-0731', model_name: 'deepseek-v4-flash' },
            ],
          },
        }),
      },
      [SNAP_MODEL_BUILTIN_URL]: {
        body: JSON.stringify({
          builtinModels: [
            { model_id: 'GLM-5.2', model_name: 'GLM-5.2' },
            { model_id: 'glm-5.3-flash', model_name: 'glm-5.3-flash' },
          ],
        }),
      },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const ids = models.map((m) => m.id)
    // benefit 模型
    expect(ids).toContain('glm-5.3-flash')
    // 日期后缀被 normalizeModelId 去掉
    expect(ids).toContain('deepseek-v4-flash')
    expect(ids).not.toContain('deepseek-v4-flash-0731')
    // 常规模型
    expect(ids).toContain('GLM-5.2')
    // 去重：glm-5.3-flash 只出现一次
    expect(ids.filter((id) => id === 'glm-5.3-flash')).toHaveLength(1)
  })

  it('returns empty array when credential lacks AK/SK', async () => {
    const { fetcher, calls } = makeFetcher({})
    const cred = makeCredential()
    cred.access_key_id = ''
    const models = await fetchCodeArtsRemoteModels(cred, fetcher)
    expect(models).toEqual([])
    expect(calls).toHaveLength(0)
  })
})
