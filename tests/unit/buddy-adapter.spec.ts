import { LlmError } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it } from 'vitest'
import { CHAT_API_BASE, BuddyAdapter, DEFAULT_MODEL } from '../../src/buddy-adapter.js'
import type { BuddyCredential } from '../../src/buddy.js'

const CREDENTIAL_REF = credentialRef('BUDDY_ACCESS_TOKEN')

/** 构造一个未过期的凭据。 */
function makeCredential(overrides: Partial<BuddyCredential> = {}): BuddyCredential {
  return {
    access_token: 'AT',
    refresh_token: 'RT',
    expires_at: String(Date.now() + 7_200_000),
    token_type: 'Bearer',
    scope: '',
    domain: 'copilot.tencent.com',
    ...overrides,
  }
}

/** adapter.stream() 的最小 GenerateOptions 形参。 */
const streamOptions = {
  model: DEFAULT_MODEL,
  messages: [],
  signal: new AbortController().signal,
} as never

/** 将 SSE 文本包装为流式 Response。 */
function sseResponse(body: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

function makeAdapter(overrides: {
  credential?: BuddyCredential | undefined
  refresh?: () => Promise<void>
  /** refresh() 之后 resolveCredential 应返回的值；默认刷新成功（恢复为有效凭据）。 */
  postRefreshCredential?: BuddyCredential | undefined
  fetchImpl?: typeof fetch
  fetchRemoteModels?: () => Promise<Array<{ id: string; name: string; contextWindow?: number }>>
} = {}) {
  let credential = 'credential' in overrides ? overrides.credential : makeCredential()
  const refresh = overrides.refresh ?? (async () => {})
  const fetchImpl = overrides.fetchImpl ?? (async () => new Response('not found', { status: 404 }))
  return new BuddyAdapter({
    credentialRef: CREDENTIAL_REF,
    resolveCredential: async () => credential,
    refresh: async () => {
      await refresh()
      credential = 'postRefreshCredential' in overrides ? overrides.postRefreshCredential : makeCredential()
    },
    fetchImpl,
    ...overrides.fetchRemoteModels !== undefined ? { fetchRemoteModels: overrides.fetchRemoteModels } : {},
  })
}

describe('BuddyAdapter', () => {
  it('providerInfo identifies the buddy route', () => {
    expect(makeAdapter().providerInfo('buddy')).toMatchObject({ id: 'buddy', name: 'CodeBuddy (Tencent)' })
  })

  it('listModels falls back to the static catalog when no remote source is configured', async () => {
    const models = await makeAdapter().listModels('buddy')
    expect(models.map((m) => m.id)).toContain('deepseek-v4-flash')
    expect(models.map((m) => m.id)).toContain('glm-5.3')
    expect(models.every((m) => m.provider === 'buddy')).toBe(true)
  })

  it('listModels prefers the remote catalog and caches it', async () => {
    let calls = 0
    const adapter = makeAdapter({
      fetchRemoteModels: async () => {
        calls++
        return [{ id: 'remote-model', name: 'Remote Model' }]
      },
    })
    const first = await adapter.listModels('buddy')
    const second = await adapter.listModels('buddy')
    expect(first.map((m) => m.id)).toEqual(['remote-model'])
    expect(second.map((m) => m.id)).toEqual(['remote-model'])
    expect(calls).toBe(1, '远端列表只应拉取一次')
  })

  it('listModels falls back to the static catalog when the remote fetch fails', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => { throw new Error('network down') },
    })
    const models = await adapter.listModels('buddy')
    expect(models.map((m) => m.id)).toContain('deepseek-v4-flash')
  })

  it('resolveModel reports the known context window', async () => {
    const resolved = await makeAdapter().resolveModel('buddy', 'deepseek-v4-flash')
    expect(resolved).toMatchObject({ provider: 'buddy', id: 'deepseek-v4-flash', context: { contextWindow: 1_000_000 } })
  })

  it('resolveModel matches the Rust fallback table for glm and hy models', async () => {
    // 对齐 deveco-code-rust BuddyProvider::context_limit 静态 fallback：
    // glm-5.3-flash 1M（此前误配 200k，导致 web 上下文表显示 ~200K）。
    const adapter = makeAdapter()
    expect((await adapter.resolveModel('buddy', 'glm-5.3-flash')).context).toEqual({ contextWindow: 1_000_000 })
    expect((await adapter.resolveModel('buddy', 'glm-5.3')).context).toEqual({ contextWindow: 1_000_000 })
    expect((await adapter.resolveModel('buddy', 'glm-5.2')).context).toEqual({ contextWindow: 1_000_000 })
    expect((await adapter.resolveModel('buddy', 'glm-5.1')).context).toEqual({ contextWindow: 200_000 })
    expect((await adapter.resolveModel('buddy', 'minimax-m3')).context).toEqual({ contextWindow: 512_000 })
    expect((await adapter.resolveModel('buddy', 'kimi-k2.6')).context).toEqual({ contextWindow: 256_000 })
  })

  it('resolveModel prefers the remote maxInputTokens over the static table', async () => {
    // /v3/config data.models[].maxInputTokens 是权威来源（对齐 Rust
    // context_limit_for_model 两级查找）：远端下发值覆盖静态 fallback。
    const adapter = makeAdapter({
      fetchRemoteModels: async () => [{ id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', contextWindow: 1_048_576 }],
    })
    const resolved = await adapter.resolveModel('buddy', 'glm-5.3-flash')
    expect(resolved.context).toEqual({ contextWindow: 1_048_576 })
  })

  it('resolveModel falls back to the static table when the remote value is absent', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => [{ id: 'glm-5.3-flash', name: 'GLM-5.3 Flash' }],
    })
    const resolved = await adapter.resolveModel('buddy', 'glm-5.3-flash')
    expect(resolved.context).toEqual({ contextWindow: 1_000_000 })
  })

  it('resolveModel omits context for unknown models', async () => {
    const resolved = await makeAdapter().resolveModel('buddy', 'unknown-model')
    expect(resolved.context).toBeUndefined()
  })

  // 回归：dsh-llm 0.1.1-rc.2 的 LlmRuntime.prepareCall() 会直接调用
  // registration.adapter.prepareCall()，而本仓库链接的副本（0.1.0-rc.6）
  // 的 LlmAdapter 基类没有该方法——缺少时每轮请求都以
  // `registration.adapter.prepareCall is not a function` 失败。
  it('exposes prepareCall for the runtime adapter contract', async () => {
    const adapter = makeAdapter()
    expect(typeof adapter.prepareCall).toBe('function')
    const call = await adapter.prepareCall('buddy', 'hy4-preview')
    expect(call.model).toMatchObject({
      provider: 'buddy',
      id: 'hy4-preview',
      context: { contextWindow: 1_000_000 },
      inputModalities: ['text'],
    })
    expect(typeof call.stream).toBe('function')
  })

  it('prepareCall binds its stream to the same adapter instance', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'),
    })
    const call = await adapter.prepareCall('buddy', DEFAULT_MODEL)
    const chunks: Array<Record<string, any>> = []
    for await (const chunk of call.stream(streamOptions as never)) {
      chunks.push(chunk as unknown as Record<string, any>)
    }
    expect(chunks.some((c) => c.type === 'text-delta' && c.text === 'ok')).toBe(true)
  })
})

describe('BuddyAdapter credential handling', () => {
  it('stream throws MISSING_CREDENTIAL when no credential is configured', async () => {
    // credential 缺失且刷新也拿不到凭据（postRefreshCredential: undefined）。
    const adapter = makeAdapter({ credential: undefined, postRefreshCredential: undefined })
    await expect(collectChunks(adapter, streamOptions)).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('stream refreshes first when the credential is expired', async () => {
    let refreshed = false
    const adapter = makeAdapter({
      credential: makeCredential({ expires_at: String(Date.now() - 60_000) }),
      refresh: async () => { refreshed = true },
      fetchImpl: async () => sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'),
    })
    await collectChunks(adapter, streamOptions)
    expect(refreshed).toBe(true)
  })

  it('stream refreshes once and retries on HTTP 401', async () => {
    let refreshed = 0
    let calls = 0
    const adapter = makeAdapter({
      refresh: async () => { refreshed++ },
      fetchImpl: async () => {
        calls++
        return calls === 1
          ? new Response('unauthorized', { status: 401 })
          : sseResponse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
      },
    })
    const chunks = await collectChunks(adapter, streamOptions)
    expect(refreshed).toBe(1, '401 只应触发一次刷新')
    expect(calls).toBe(2)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })

  it('stream maps HTTP 429 to RATE_LIMIT and 5xx to SERVER', async () => {
    for (const [status, code] of [[429, 'RATE_LIMIT'], [500, 'SERVER'], [400, 'INVALID_REQUEST']] as const) {
      const adapter = makeAdapter({ fetchImpl: async () => new Response(`{"error":{"message":"boom"}}`, { status }) })
      const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(LlmError)
      expect((error as LlmError).failure.code).toBe(code)
    }
  })

  it('stream sends the required CodeBuddy headers', async () => {
    let seen: Headers | undefined
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        seen = new Headers(init?.headers as HeadersInit)
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, streamOptions)
    expect(seen!.get('Authorization')).toBe('Bearer AT')
    expect(seen!.get('X-Domain')).toBe('copilot.tencent.com')
    expect(seen!.get('X-Product-Code')).toBe('codebuddy')
    expect(seen!.get('User-Agent')).toBe('CodeBuddyIDE/1.106.1')
  })
})

describe('BuddyAdapter stream parsing', () => {
  it('emits text and reasoning on separate blocks', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}',
        '',
        'data: {"choices":[{"delta":{"content":"hello"}}]}',
        '',
        'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    expect(chunks.find((c) => c.type === 'block-start' && c.blockType === 'reasoning')).toBeDefined()
    expect(chunks.find((c) => c.type === 'block-start' && c.blockType === 'text')).toBeDefined()
    const text = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'text')
    expect(text[0]).toMatchObject({ block: { type: 'text', text: 'hello world' } })
    const reasoning = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'reasoning')
    expect(reasoning[0]).toMatchObject({ block: { type: 'reasoning', text: 'thinking...' } })
  })

  it('reports stop when no tool calls occur', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  // 回归：CodeBuddy 流式响应仅首个分片携带真实 id（chatcmpl-tool-xxx），
  // 后续参数分片只有 index。若按 index 生成 call_{index} 而非沿用真实 id，
  // 跨轮（每轮都从 call_0 重新编号）会导致 tool/result 配对到错误的历史条目。
  it('keeps one stable id across argument fragments of the same tool call', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"chatcmpl-tool-abc","type":"function","function":{"name":"shell","arguments":""}}]}}]}',
        '',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"command\\": \\"ls\\"}"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    const deltas = chunks.filter((c) => c.type === 'tool-call-delta')
    expect(deltas).not.toHaveLength(0)
    // 所有分片（含首个空参数分片）都必须使用后端签发的真实 id。
    for (const delta of deltas) {
      expect((delta as { id: string }).id).toBe('chatcmpl-tool-abc')
    }
    const end = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(end).toHaveLength(1)
    expect(end[0]).toMatchObject({
      block: { type: 'tool-call', id: 'chatcmpl-tool-abc', name: 'shell', arguments: '{"command": "ls"}' },
    })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  // 回归：并行工具调用各自拥有独立 id，参数分片不得混淆到同一个工具上。
  it('distinguishes parallel tool calls by id', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"chatcmpl-tool-1","function":{"name":"shell","arguments":""}},{"index":1,"id":"chatcmpl-tool-2","function":{"name":"file_read","arguments":""}}]}}]}',
        '',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"a\\":1}"}},{"index":1,"function":{"arguments":"{\\"b\\":2}"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    const ends = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(ends).toHaveLength(2)
    const byId = new Map(ends.map((c) => [(c as { block: { id: string } }).block.id, c]))
    expect(byId.get('chatcmpl-tool-1')).toMatchObject({ block: { name: 'shell', arguments: '{"a":1}' } })
    expect(byId.get('chatcmpl-tool-2')).toMatchObject({ block: { name: 'file_read', arguments: '{"b":2}' } })
  })

  // 回归：CodeBuddy 的参数续分片会带回 `"function":{"name":""}`。空串不是
  // undefined，原先的 `!== undefined` 判断会用它覆盖首个分片解析出的真实
  // 工具名，最终 block-end 输出 name:""，harness 报 `unknown tool ""`。
  it('ignores an empty function name on argument continuation fragments', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"chatcmpl-tool-1","type":"function","function":{"name":"shell","arguments":""}}]}}]}',
        '',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"","arguments":"{\\"command\\":\\"ls -"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"","arguments":"la\\"}"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    const end = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(end).toHaveLength(1)
    expect(end[0]).toMatchObject({
      block: { type: 'tool-call', id: 'chatcmpl-tool-1', name: 'shell', arguments: '{"command":"ls -la"}' },
    })
    // 续分片的空名不得传播到 delta 上。
    for (const delta of chunks.filter((c) => c.type === 'tool-call-delta')) {
      expect((delta as { name?: string }).name).toBe('shell')
    }
  })

  it('falls back to call_{index} when the backend sends no id', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"shell","arguments":"{}"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    const end = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(end[0]).toMatchObject({ block: { type: 'tool-call', id: 'call_0', name: 'shell' } })
  })

  // 'length'（输出被 max_tokens 截断）必须优先于 tool_calls：否则 harness 会执行
  // 被截断的非法 JSON 参数，并把脏参数持久化进会话历史。
  it('reports max-tokens over tool-calls when the stream is truncated', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"chatcmpl-tool-1","function":{"name":"write","arguments":"{\\"content\\": \\"trunca"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('surfaces SSE-embedded errors as SERVER failures', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse('data: {"error":{"message":"internal error"}}\n\ndata: [DONE]\n\n'),
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LlmError)
    expect(String((error as LlmError).message)).toContain('internal error')
  })

  // 回归：无参数工具（如 list_dir / get_cwd）只下发一个空的 arguments
  // 分片，拼接结果为空串。harness 解析时报
  // `invalid arguments: "arguments" must be an object`，会话卡在错误态，
  // web 端发送按钮置灰、后续指令无响应。空参数必须归一化为 {}。
  it('normalizes empty arguments of a zero-parameter tool call', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"chatcmpl-tool-1","function":{"name":"list_dir","arguments":""}}]}}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    const end = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(end).toHaveLength(1)
    expect(end[0]).toMatchObject({ block: { name: 'list_dir', arguments: '{}' } })
  })

  // 回归：SSE 流被网关掐断（无 finish_reason、无 [DONE]）时，工具参数是
  // 半截 JSON。原实现把它报告为 tool-calls，harness 执行不完整参数报
  // INVALID_ARGS 并把脏参数持久化进历史。此时应报告 max-tokens，让 dsh
  // 丢弃残缺调用并触发续写。
  it('reports max-tokens instead of executing a half-streamed tool call', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"chatcmpl-tool-1","function":{"name":"write","arguments":"{\\"content\\": \\"trunca"}}]}}]}',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'max-tokens' } })
    // 残缺参数必须原样保留，交由 max-tokens 触发重试。绝不能补成 {}——
    // 那会让 harness 报 `missing required property` 而非重试。
    const end = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(end[0]!.block.arguments).not.toBe('{}')
  })

  // 回归（核心）：hy4-preview 并行下发多个工具调用时会丢参数分片，两个调用
  // 都只剩残缺片段（实测 session-23851745 turn1 step4）。此前适配器把残缺
  // JSON 补成 {}，伪造出合法外观，harness 执行时报
  // `missing required property "file_path"`，模型收到莫名其妙的参数错误并
  // 陷入重试循环。现在必须判定为截断、报告 max-tokens 触发 dsh 重试。
  it('reports max-tokens when parallel tool calls lose argument fragments', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        // 两个并行 read：参数开头的 `{"file_path": "D:\\...` 前缀丢失。
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tool-a","function":{"name":"read","arguments":""}}]}}]}',
        '',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"","arguments":"\\\\deveco-code-rust\\\\cr"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"","arguments":"ates\\\\deveco"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"tool-b","function":{"name":"read","arguments":"o-llm\\\\src\\\\provider\\\\buddy.rs\\"}"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    // 后端声明 finish_reason=tool_calls，但参数残缺——必须覆盖为 max-tokens，
    // 否则 harness 会执行这两个缺参调用。
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  // 回归：后端掐断连接但既不发数据也不关连接（半开连接）时，裸
  // reader.read() 永久挂起——generator 不返回，harness 步骤既不出结果
  // 也不报错，会话永远停在"运行中"，web 端发送按钮置灰、"继续"无响应。
  // 必须主动超时并抛可重试的 TIMEOUT，把控制权交还给用户。
  it('fails fast with a retryable TIMEOUT when the stream stalls', async () => {
    // 默认 firstTokenTimeout 为 120s，测试里缩短到 20ms 触发超时路径。
    // 环境变量在每次 stream() 调用时读取，因此这里设置即时生效。
    process.env.DSH_BUDDY_SSE_FIRST_TOKEN_TIMEOUT_MS = '20'
    try {
      const adapter = makeAdapter({
        fetchImpl: async () => new Response(
          new ReadableStream<Uint8Array>({ start() { /* 永不产出数据 */ } }),
          { status: 200 },
        ),
      })
      const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(LlmError)
      expect((error as LlmError).failure.code).toBe('TIMEOUT')
    } finally {
      delete process.env.DSH_BUDDY_SSE_FIRST_TOKEN_TIMEOUT_MS
    }
  })

  it('skips malformed SSE lines', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse('data: not-json\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })
})

describe('BuddyAdapter message serialization', () => {
  it('sends assistant reasoning_content and null content for tool-only turns', async () => {
    let body: string | undefined
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        body = init?.body as string
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [
        { role: 'assistant', content: [
          { type: 'reasoning', text: 'let me check' },
          { type: 'tool-call', id: 'call_1', name: 'shell', arguments: '{"command":"ls"}' },
        ] },
        { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'file.txt' }] }] },
      ] as never,
      signal: new AbortController().signal,
    } as never)

    const payload = JSON.parse(body!) as { messages: Array<Record<string, unknown>> }
    const assistant = payload.messages[0]
    expect(assistant.role).toBe('assistant')
    // 正文为空且带 tool_calls 时 content 必须为 null（对齐 openai_chat.rs）。
    expect(assistant.content).toBeNull()
    // 推理模型要求 assistant 消息始终携带 reasoning_content 字段。
    expect(assistant.reasoning_content).toBe('let me check')
    expect(assistant.tool_calls).toMatchObject([{ id: 'call_1', type: 'function', function: { name: 'shell' } }])

    // 工具结果展开为独立的 role:'tool' 消息。
    const tool = payload.messages[1]
    expect(tool).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: 'file.txt' })
  })

  // 回归（严重）：工具执行失败时，assistant 的 tool_calls 会留在会话历史里，
  // 但对应的 tool 结果消息从未写入——形成孤儿 tool_calls。OpenAI 兼容后端
  // 要求带 tool_calls 的 assistant 消息必须紧跟对应 tool 消息，否则每次
  // 请求都 400。由于坏历史被持久化并随每次请求重放，**后续所有消息都会
  // 石沉大海**，整个会话永久报废。适配器是最后一道防线，必须清理。
  it('drops orphan tool_calls that have no tool result', async () => {
    let body: string | undefined
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        body = init?.body as string
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [
        { role: 'user', content: 'list the files' },
        // 助手发起了 Grep 调用，但参数非法导致执行失败，结果从未写回历史。
        { role: 'assistant', content: [
          { type: 'tool-call', id: 'call_1', name: 'Grep', arguments: '' },
        ] },
        // 用户随后发的消息中没有对应的 tool-result。
        { role: 'user', content: 'continue' },
      ] as never,
      signal: new AbortController().signal,
    } as never)

    const payload = JSON.parse(body!) as { messages: Array<Record<string, any>> }
    const assistant = payload.messages.find((m) => m.role === 'assistant')
    expect(assistant).toBeDefined()
    // 孤儿 tool_calls 必须被剥离，否则后端永久 400、会话报废。
    expect(assistant!.tool_calls).toBeUndefined()
  })

  // 回归：只有部分工具调用拿到结果时同样不合法——后端要求 tool_calls 中
  // 的每一个 id 都有对应 tool 消息，缺一个就整体拒绝。
  it('drops a whole tool_calls batch when only part of it has results', async () => {
    let body: string | undefined
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        body = init?.body as string
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [
        { role: 'assistant', content: [
          { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a"}' },
          { type: 'tool-call', id: 'call_2', name: 'read', arguments: '{"path":"b"}' },
        ] },
        // 只有 call_1 拿到结果；call_2 是孤儿。
        { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'ok' }] }] },
      ] as never,
      signal: new AbortController().signal,
    } as never)

    const payload = JSON.parse(body!) as { messages: Array<Record<string, any>> }
    const assistant = payload.messages.find((m) => m.role === 'assistant')
    expect(assistant!.tool_calls).toBeUndefined()
  })

  // 回归：孤儿的 role:'tool' 消息（没有对应的前置 tool_call）同样会被后端
  // 拒绝。assistant 消息被丢弃时可能出现，必须一并清理。
  it('drops orphan tool result messages', async () => {
    let body: string | undefined
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        body = init?.body as string
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [
        { role: 'user', content: 'hi' },
        // 没有任何 assistant tool_call 与之对应。
        { role: 'user', content: [{ type: 'tool-result', toolCallId: 'ghost', content: [{ type: 'text', text: 'x' }] }] },
      ] as never,
      signal: new AbortController().signal,
    } as never)

    const payload = JSON.parse(body!) as { messages: Array<Record<string, unknown>> }
    expect(payload.messages.some((m) => m.role === 'tool')).toBe(false)
  })

  // 保序回归：正常的工具往返（每个 tool_call 都有结果）必须原样保留，
  // 清理逻辑不得误伤健康会话。
  it('keeps well-formed tool round-trips intact', async () => {
    let body: string | undefined
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        body = init?.body as string
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [
        { role: 'assistant', content: [
          { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a"}' },
          { type: 'tool-call', id: 'call_2', name: 'read', arguments: '{"path":"b"}' },
        ] },
        { role: 'user', content: [
          { type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'A' }] },
          { type: 'tool-result', toolCallId: 'call_2', content: [{ type: 'text', text: 'B' }] },
        ] },
      ] as never,
      signal: new AbortController().signal,
    } as never)

    const payload = JSON.parse(body!) as { messages: Array<Record<string, any>> }
    const assistant = payload.messages.find((m) => m.role === 'assistant')
    expect(assistant!.tool_calls).toHaveLength(2)
    expect(payload.messages.filter((m) => m.role === 'tool')).toHaveLength(2)
  })

  it('sends tools and the system prompt', async () => {
    let body: string | undefined
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        body = init?.body as string
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      system: 'You are helpful',
      messages: [{ role: 'user', content: 'hi' }] as never,
      tools: [{ name: 'shell', description: 'run a command', parameters: { type: 'object' } }],
      signal: new AbortController().signal,
    } as never)
    const payload = JSON.parse(body!) as { messages: Array<Record<string, unknown>>; tools?: unknown[] }
    expect(payload.messages[0]).toMatchObject({ role: 'system', content: 'You are helpful' })
    expect(payload.tools).toMatchObject([{ type: 'function', function: { name: 'shell' } }])
  })
})

/** 收集流中所有 chunk；流抛错时 reject。 */
async function collectChunks(adapter: BuddyAdapter, options: never): Promise<Array<Record<string, any>>> {
  const chunks: Array<Record<string, any>> = []
  for await (const chunk of adapter.stream(options as never)) {
    chunks.push(chunk as unknown as Record<string, any>)
  }
  return chunks
}

/**
 * 账号池限流切换。
 *
 * 覆盖的关键行为：一个账号触发用量限制后，应逐个尝试其余可用账号，
 * **每个失败账号都要记录其限流重置时间**（UI 据此展示限流标记），
 * 只有真正试完全部候选才报"所有账号均受限"。此前实现只试一个账号
 * 就下结论，导致"UI 上还有未限流账号，对话却报全部受限"。
 */
describe('BuddyAdapter 账号池限流切换', () => {
  /** 构造 6004 频率限制响应体。resetAt 用远未来时间，避免测试随时钟漂移。 */
  function rateLimitBody(): string {
    return JSON.stringify({
      code: 6004,
      msg: '您的使用量已超出频率限制，将在 2099-12-31 23:59:59 UTC+8 重置，您也可以切换其他模型继续使用。',
    })
  }

  /**
   * 记录 updateModelRateLimit / getAvailableAccount 调用的轻量 AccountPool 替身。
   * @param current - 会话开始时就已启用的当前账号（token 与 resolveCredential 一致）
   * @param candidates - 切换时按顺序返回的候选账号
   */
  function makePool(
    current: { id: string; token: string },
    candidates: Array<{ id: string; token: string }>,
  ) {
    const recorded: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
    const known = [current, ...candidates]
    const queue = [...candidates]
    return {
      recorded,
      /** 适配器用凭据内容反查账号 id。 */
      async findAccountIdByCredential(_provider: string, identity: string) {
        return known.find((a) => a.token === identity)?.id ?? ''
      },
      async updateModelRateLimit(accountId: string, modelId: string, resetAtMs: number) {
        recorded.push({ accountId, modelId, resetAtMs })
      },
      async getAvailableAccount() {
        const next = queue.shift()
        if (next === undefined) return null
        return { entry: { id: next.id }, credential: makeCredential({ access_token: next.token }) }
      },
    }
  }

  it('逐个尝试所有账号，每个失败账号都被记录限流', async () => {
    const pool = makePool(
      { id: 'acct-1', token: 'AT1' },
      [
        { id: 'acct-2', token: 'AT2' },
        { id: 'acct-3', token: 'AT3' },
      ],
    )
    const sentTokens: string[] = []
    const adapter = new BuddyAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => makeCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: pool as never,
      fetchImpl: async (_url, init) => {
        const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
        const token = auth.replace('Bearer ', '')
        sentTokens.push(token)
        // AT1 与 AT2 都限流，AT3 成功 —— 三个账号各试一次
        if (token === 'AT3') {
          return sseResponse('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        }
        return new Response(rateLimitBody(), { status: 400 })
      },
    })

    const chunks = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never)

    // 三个账号都被尝试过，最终由 AT3 成功返回内容
    expect(sentTokens).toEqual(['AT1', 'AT2', 'AT3'])
    expect(chunks.some((c) => c.type === 'text-delta' && c.text === 'ok')).toBe(true)
    // 关键断言：失败的两个账号都被记录了限流时间（UI 才能显示标记）
    expect(pool.recorded.map((r) => r.accountId)).toEqual(['acct-1', 'acct-2'])
    expect(pool.recorded.every((r) => r.modelId === DEFAULT_MODEL)).toBe(true)
    expect(pool.recorded.every((r) => r.resetAtMs > Date.now())).toBe(true)
  })

  it('全部账号限流后才报错，且错误码为不可重试的 QUOTA_EXCEEDED', async () => {
    const pool = makePool({ id: 'acct-1', token: 'AT1' }, [{ id: 'acct-2', token: 'AT2' }])
    const adapter = new BuddyAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => makeCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: pool as never,
      fetchImpl: async () => new Response(rateLimitBody(), { status: 400 }),
    })

    const error = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).code).toBe('QUOTA_EXCEEDED')
    // 两个账号都被记录了限流
    expect(pool.recorded.map((r) => r.accountId)).toEqual(['acct-1', 'acct-2'])
  })

  it('切换到的新账号以非限流错误失败时，抛出原始错误而非"全部受限"', async () => {
    const pool = makePool({ id: 'acct-1', token: 'AT1' }, [{ id: 'acct-2', token: 'AT2' }])
    const adapter = new BuddyAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => makeCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: pool as never,
      fetchImpl: async (_url, init) => {
        const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
        const token = auth.replace('Bearer ', '')
        if (token === 'AT2') {
          return new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 })
        }
        return new Response(rateLimitBody(), { status: 400 })
      },
    })

    const error = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LlmError)
    // 不应被吞成 QUOTA_EXCEEDED —— 这是模型/请求错误，需要如实上报
    expect((error as LlmError).code).not.toBe('QUOTA_EXCEEDED')
    expect((error as LlmError).message).toContain('model not found')
  })
})

/** 端点常量供测试断言引用（避免硬编码字符串漂移）。 */
export { CHAT_API_BASE }
