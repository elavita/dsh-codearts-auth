import { LlmError } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { CHAT_API_BASE, CodeArtsAdapter, QUEUE_STATUS_BASE } from '../../src/llm-adapter.js'
import type { CodeArtsCredential } from '../../src/types.js'

const CREDENTIAL_REF = credentialRef('CODEARTS_ACCESS_TOKEN')

const validCredential: CodeArtsCredential = {
  access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
  expires_at: '2099-01-01T00:00:00Z',
}

/** adapter.stream() 的最小 GenerateOptions 形参。 */
const streamOptions = {
  model: 'GLM-5.2',
  messages: [],
  signal: new AbortController().signal,
} as never

function makeAdapter(overrides: {
  credential?: CodeArtsCredential | undefined
  refresh?: () => Promise<void>
  fetchImpl?: typeof fetch
} = {}) {
  let credential = 'credential' in overrides ? overrides.credential : validCredential
  const refresh = overrides.refresh ?? (async () => {})
  const fetchImpl = overrides.fetchImpl ?? (async () => new Response('not found', { status: 404 }))
  const adapter = new CodeArtsAdapter({
    credentialRef: CREDENTIAL_REF,
    resolveCredential: async () => credential,
    refresh: async () => { await refresh(); credential = validCredential },
    fetchImpl,
  })
  return adapter
}

describe('CodeArtsAdapter', () => {
  it('providerInfo identifies the codearts route', () => {
    expect(makeAdapter().providerInfo('codearts')).toMatchObject({ id: 'codearts', name: 'CodeArts Agent' })
  })

  it('listModels advertises the openpangu-2.0 and deepseek-v4 models alongside the GLM family', async () => {
    // 对齐 deveco-code-rust 参考实现 codearts.rs：新增盘古模型
    // openpangu-2.0-flash (92B) / openpangu-2.0-pro (505B)，
    // 后端 /v1/default/models 下发的 model_id 为全小写。
    // DeepSeek V4（对齐 deveco-code 62834ff6）：CodeArts Agent 模型列表新增
    // deepseek-v4-flash / deepseek-v4-pro（UI 标注每日 1000 万免费 Tokens 福利）。
    // e2e 实测确认后端实际注册的 flash ID 是 deepseek-v4-flash（无 -0731 后缀），
    // IDE 显示的 deepseek-v4-flash-0731 后端返回 404 not registered。
    const models = await makeAdapter().listModels('codearts')
    const ids = models.map(model => model.id)
    expect(ids).toContain('openpangu-2.0-flash')
    expect(ids).toContain('openpangu-2.0-pro')
    expect(ids).toContain('deepseek-v4-flash')
    expect(ids).toContain('deepseek-v4-pro')
    const flash = models.find(model => model.id === 'openpangu-2.0-flash')
    const pro = models.find(model => model.id === 'openpangu-2.0-pro')
    const dsFlash = models.find(model => model.id === 'deepseek-v4-flash')
    const dsPro = models.find(model => model.id === 'deepseek-v4-pro')
    expect(flash).toMatchObject({ provider: 'codearts', name: 'openpangu-2.0-flash' })
    expect(pro).toMatchObject({ provider: 'codearts', name: 'openpangu-2.0-pro' })
    expect(dsFlash).toMatchObject({ provider: 'codearts', name: 'deepseek-v4-flash' })
    expect(dsPro).toMatchObject({ provider: 'codearts', name: 'deepseek-v4-pro' })
    // 默认模型仍是 GLM-5.2（新增模型不应改变默认模型）。
    expect(ids[0]).toBe('GLM-5.2')
  })

  it('streams text deltas from an OpenAI-compatible SSE response', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
      + 'data: {"choices":[{"delta":{"content":" there"}}]}\n\n'
      + 'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const chunks: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') chunks.push(chunk.text)
    }
    expect(chunks).toEqual(['hi', ' there'])
  })

  it('refreshes an expired credential before streaming and signs the request', async () => {
    let refreshed = false
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(String(input)).toBe(`${CHAT_API_BASE}/chat/completions`)
      expect(headers.get('Authorization')).toMatch(/^SDK-HMAC-SHA256 Access=AK/)
      expect(headers.get('x-security-token')).toBe('ST')
      expect(headers.get('Chat-Id')).toBeTruthy()
      expect(refreshed).toBe(true)
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200 })
    })
    const adapter = makeAdapter({
      credential: { ...validCredential, expires_at: '2020-01-01T00:00:00Z' },
      refresh: async () => { refreshed = true },
      fetchImpl,
    })
    const texts: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    expect(refreshed).toBe(true)
    expect(texts).toEqual(['ok'])
  })

  it('refreshes the credential once when the chat request fails with APIG.0602 and retries successfully', async () => {
    // CodeArts 经华为 APIG 网关鉴权：SecurityToken 过期/无效时网关返回
    // APIG.0602 "Invalid token"。入口的 expires_at 预判无法覆盖后端提前
    // 吊销或时钟偏差，stream() 应在收到该错误后触发一次静默 refresh，
    // 用新凭据重试 chat 请求；最多 refresh 一次，避免死循环。
    let refreshed = false
    let chatCalls = 0
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        return new Response(JSON.stringify({ status: 'working', queue_position: 0, message: '' }))
      }
      chatCalls += 1
      if (chatCalls === 1) {
        return new Response(JSON.stringify({ error_code: 'APIG.0602', error_msg: 'Invalid token' }), { status: 401 })
      }
      // 第二次请求在 refresh 后发出，应使用刷新后的凭据（makeAdapter 的
      // refresh() 会把 credential 恢复为 validCredential）。
      const headers = new Headers(init?.headers)
      expect(headers.get('x-security-token')).toBe('ST')
      expect(refreshed).toBe(true)
      return new Response('data: {"choices":[{"delta":{"content":"recovered"}}]}\n\ndata: [DONE]\n\n', { status: 200 })
    })
    const adapter = makeAdapter({
      refresh: async () => { refreshed = true },
      fetchImpl,
    })
    const texts: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    expect(chatCalls).toBe(2)
    expect(refreshed).toBe(true)
    expect(texts).toEqual(['recovered'])
  })

  it('does not refresh more than once on repeated auth errors', async () => {
    // 连续两次 APIG.0602：第一次触发 refresh+重试，第二次仍失败应直接抛 AUTH，
    // 不再刷新，避免死循环。
    let refreshCount = 0
    let chatCalls = 0
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        return new Response(JSON.stringify({ status: 'working', queue_position: 0, message: '' }))
      }
      chatCalls += 1
      return new Response(JSON.stringify({ error_code: 'APIG.0602', error_msg: 'Invalid token' }), { status: 401 })
    })
    const adapter = makeAdapter({
      refresh: async () => { refreshCount += 1 },
      fetchImpl,
    })
    await expect(async () => {
      for await (const _ of adapter.stream(streamOptions)) { /* drain */ }
    }).rejects.toMatchObject({ code: 'AUTH' })
    expect(chatCalls).toBe(2)
    expect(refreshCount).toBe(1)
  })

  it('throws MISSING_CREDENTIAL when no credential is available', async () => {
    // 直接构建适配器：makeAdapter 的 refresh() 会恢复
    // 有效凭据，因此"刷新后仍无凭据"需要用原始适配器。
    const adapter = new CodeArtsAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => undefined,
      refresh: async () => {},
      fetchImpl: async () => new Response('not found', { status: 404 }),
    })
    await expect(async () => {
      for await (const _ of adapter.stream(streamOptions)) { /* drain */ }
    }).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('normalizes a non-2xx response to an LlmError', async () => {
    const adapter = makeAdapter({ fetchImpl: async () => new Response('nope', { status: 500 }) })
    await expect(async () => {
      for await (const _ of adapter.stream(streamOptions)) { /* drain */ }
    }).rejects.toBeInstanceOf(LlmError)
  })

  it('retries the chat request after a queue error even when the queue status is working', async () => {
    // 对齐参考实现 runner.rs：排队时直接重试 chat 请求，不轮询等待
    // working。状态端点仅在每次重试前查一次（此处 working 非终态，
    // 不抛错），等待 10s 后重试 chat 成功。
    const calls = { chat: 0, queue: 0 }
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        calls.queue += 1
        return new Response(
          JSON.stringify({ status: 'working', queue_position: 1, message: 'admitted' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      calls.chat += 1
      if (calls.chat === 1) {
        // 第一次 chat 调用被并发上限限流。
        return new Response(
          JSON.stringify({ error_code: 'TM.00001041', error_msg: '并发会话数已达上限(3个)，请关闭部分会话后重试。' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"queued-ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const texts: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    expect(texts).toEqual(['queued-ok'])
    expect(calls.chat).toBe(2)
    expect(calls.queue).toBe(1)
  }, 30_000)

  it('directly retries the chat request while queued instead of waiting for working', async () => {
    // 对齐参考实现 runner.rs：排队时直接重试 chat 请求（10s 一次），
    // 不轮询等待状态端点 working。状态端点仅在每次重试前查一次，
    // 用于检测终态（error/queue_full）提前抛错。
    const calls = { chat: 0, queue: 0 }
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        calls.queue += 1
        return new Response(
          JSON.stringify({ status: 'waiting', queue_position: calls.queue, message: 'queue status' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      calls.chat += 1
      if (calls.chat === 1) {
        return new Response(
          JSON.stringify({ error_code: 'TM.00001041', error_msg: '并发会话数已达上限(3个)，请关闭部分会话后重试。' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"finally"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const texts: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    expect(texts).toEqual(['finally'])
    expect(calls.chat).toBe(2)
    // 排队中不轮询状态端点：仅重试前查一次。
    expect(calls.queue).toBe(1)
  }, 30_000)

  it('retries the chat request when the SSE stream carries the TPM limit error (81111.429)', async () => {
    // CodeArts 以 HTTP 200 + SSE 内嵌 error_code 返回 TPM 限流
    // （InferHub.ModelArts.81111.429），而非 4xx。适配器必须把它当成排队
    // 处理（延迟后重试 chat），而不是静默当成 [DONE] 流结束吞掉——否则
    // 用户看到"思考后无输出"。本用例：第一次请求 SSE 返回该错误，重试后
    // 第二次返回正常文本。
    const calls = { chat: 0, queue: 0 }
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        calls.queue += 1
        return new Response(
          JSON.stringify({ status: 'waiting', queue_position: calls.queue, message: 'queue status' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      calls.chat += 1
      if (calls.chat === 1) {
        // HTTP 200 + SSE 内嵌排队/限流错误（e2e 实测的真实响应形态）。
        return new Response(
          'data:{"text":"[DONE]","error_code":"InferHub.ModelArts.81111.429","error_msg":"The model TPM limit has been significantly exceeded. Please reduce the request rate and retry later."}\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"admitted-ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const blocks: string[] = []
    const texts: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'block-start') blocks.push(chunk.blockType)
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    // 81111.429 被识别为排队错误：重试 chat 后成功输出正文。
    expect(calls.chat).toBe(2)
    expect(calls.queue).toBe(1)
    // 排队/限流期间零产出：只有重试成功后的正文文本块。
    expect(blocks).toEqual(['text'])
    expect(texts).toEqual(['admitted-ok'])
  }, 30_000)

  it('emits no content blocks while waiting for queue admission', async () => {
    // 排队期间适配器不得产出任何内容块：StreamChunk 协议没有瞬态状态通道，
    // reasoning/text 块都会被组装进 assistant 消息并持久化（reasoning 还会
    // 显示在 web 的 Think 区域，visible 回退可能把推理文本回传给模型），
    // 因此排队提示既不显示也不留痕，web 显示 harness 自身的"运行中"状态。
    const calls = { chat: 0, queue: 0 }
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        calls.queue += 1
        return new Response(
          JSON.stringify({ status: 'waiting', queue_position: calls.queue, message: 'queue status' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      calls.chat += 1
      if (calls.chat === 1) {
        return new Response(
          JSON.stringify({ error_code: 'TM.00001041', error_msg: '并发会话数已达上限(3个)，请关闭部分会话后重试。' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"admitted-ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const blocks: string[] = []
    const texts: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'block-start') blocks.push(chunk.blockType)
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    // 排队期间零产出：放行后只有正文文本块。
    expect(blocks).toEqual(['text'])
    expect(texts).toEqual(['admitted-ok'])
    expect(calls.chat).toBe(2)
    // 排队中只重试前查一次状态端点（终态检测），不轮询等待 working。
    expect(calls.queue).toBe(1)
  }, 30_000)

  it('never leaks queue notices into the visible text fallback when the model returns reasoning only', async () => {
    // GLM 特性：模型可能只返回 reasoning_content 而 content 为空，适配器
    // 回退把推理作为可见文本。排队提示必须被排除在该回退之外——否则排队
    // 文本会作为正文持久化并在后续调用中作为上下文发送给模型。
    const calls = { chat: 0, queue: 0 }
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        calls.queue += 1
        const status = calls.queue === 1 ? 'waiting' : 'working'
        return new Response(
          JSON.stringify({ status, queue_position: calls.queue, message: 'queue status' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      calls.chat += 1
      if (calls.chat === 1) {
        return new Response(
          JSON.stringify({ error_code: 'TM.00001041', error_msg: '并发会话数已达上限(3个)，请关闭部分会话后重试。' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        'data: {"choices":[{"delta":{"reasoning_content":"real-reasoning"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const textEnds: string[] = []
    const reasoningEnds: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'block-end' && chunk.block.type === 'text') textEnds.push(chunk.block.text)
      if (chunk.type === 'block-end' && chunk.block.type === 'reasoning') reasoningEnds.push(chunk.block.text)
    }
    // 可见文本回退只包含模型真实推理；排队期间零产出，故绝无"排队中"字样。
    expect(textEnds.some(text => text.includes('排队中'))).toBe(false)
    expect(textEnds).toEqual(['real-reasoning'])
    // reasoning 块只有模型真实推理，不持久化任何排队文本。
    expect(reasoningEnds.every(text => !text.includes('排队中'))).toBe(true)
    expect(calls.chat).toBe(2)
    // 排队中只重试前查一次状态端点（终态检测），不轮询等待 working。
    expect(calls.queue).toBe(1)
  }, 30_000)

  it('enters the queue path for non-TM.00001041 errors when the queue endpoint reports waiting (openpangu)', async () => {
    // openpangu 等模型的并发限流错误码/HTTP 状态可能与 GLM 的
    // TM.00001041 不同（例如 HTTP 429 + 其他错误码），但只要排队状态
    // 端点确认会话在排队，适配器就必须进入排队逻辑而不是立即抛错。
    const calls = { chat: 0, queue: 0 }
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        calls.queue += 1
        const status = calls.queue <= 2 ? 'waiting' : 'working'
        return new Response(
          JSON.stringify({ status, queue_position: calls.queue, message: 'queue status' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      calls.chat += 1
      if (calls.chat === 1) {
        return new Response(
          JSON.stringify({ error_code: 'TM.00001042', error_msg: '并发请求过多，请稍后重试。' }),
          { status: 429, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"admitted-ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const reasoning: string[] = []
    const texts: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'reasoning-delta') reasoning.push(chunk.text)
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    // 探测一次（确认排队）+ 重试前查一次状态端点（终态检测），重试 chat 成功。
    expect(calls.chat).toBe(2)
    expect(calls.queue).toBe(2)
    // 排队期间零产出：不放行后正文之前没有任何块（无"排队中"字样）。
    expect(reasoning).toEqual([])
    expect(texts).toEqual(['admitted-ok'])
  }, 30_000)

  it('surfaces the queue error message when the queue status is terminal', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        return new Response(
          JSON.stringify({ status: 'error', queue_position: -1, message: 'peak hours, try later' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        JSON.stringify({ error_code: 'TM.00001041', error_msg: '并发会话数已达上限' }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    await expect(async () => {
      for await (const _ of adapter.stream(streamOptions)) { /* drain */ }
    }).rejects.toThrow(/peak hours, try later/)
  })

  it('throws a normal HTTP error when the failure is not a queue error', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error_code: 'OTHER', error_msg: 'bad request' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    await expect(async () => {
      for await (const _ of adapter.stream(streamOptions)) { /* drain */ }
    }).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('translates tool_calls deltas into tool-call blocks so the harness can run them', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n'
      + 'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const seen: string[] = []
    let toolCallBlock: { type: 'tool-call'; id: string; name: string; arguments: string } | undefined
    let finishKind: string | undefined
    for await (const chunk of adapter.stream(streamOptions)) {
      seen.push(chunk.type)
      if (chunk.type === 'tool-call-delta') {
        expect(chunk.id).toBe('call-1')
        expect(chunk.name).toBe('bash')
        expect(chunk.argumentsDelta).toContain('ls')
      }
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') toolCallBlock = chunk.block
      if (chunk.type === 'finish') finishKind = chunk.reason.kind
    }
    expect(toolCallBlock).toMatchObject({ type: 'tool-call', id: 'call-1', name: 'bash' })
    expect(JSON.parse(toolCallBlock!.arguments)).toEqual({ command: 'ls' })
    expect(finishKind).toBe('tool-calls')
  })

  it('serializes harness tool schemas into the request tools field', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body ?? '{}')) as {
        model?: string
        tools?: Array<{ type: string; function: { name: string; description: string; parameters: unknown } }>
        tool_stream?: boolean
      }
      expect(sent.model).toBe('GLM-5.2')
      // 对齐 CodeArts Agent IDE：tool_stream=true 让后端对超大工具
      // 调用参数（如大文件 file_write）分段流式传输，避免单次 SSE 事件
      // 过大导致连接被掐断（error decoding response body）。
      expect(sent.tool_stream).toBe(true)
      expect(sent.tools).toEqual([{
        type: 'function',
        function: {
          name: 'bash',
          description: 'Run a shell command',
          parameters: { type: 'object', properties: { command: { type: 'string' } } },
        },
      }])
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const opts = {
      provider: 'codearts',
      model: 'GLM-5.2',
      messages: [],
      tools: [{
        name: 'bash',
        description: 'Run a shell command',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
      }],
      signal: new AbortController().signal,
    } as never
    for await (const _ of adapter.stream(opts)) { /* drain */ }
    expect(fetchImpl).toHaveBeenCalled()
  })

  it('replays assistant tool_calls and tool results back to the model', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<Record<string, unknown>>
      }
      const wire = sent.messages ?? []
      // 助手消息携带其 tool_calls；随后用户消息的
      // tool-result 块展开为 role:'tool' 传输消息。
      const assistant = wire.find(message => message.role === 'assistant') as Record<string, unknown> | undefined
      expect(assistant?.tool_calls).toEqual([{
        id: 'call-9',
        type: 'function',
        function: { name: 'bash', arguments: '{"command":"ls"}' },
      }])
      const tool = wire.find(message => message.role === 'tool') as Record<string, unknown> | undefined
      expect(tool?.tool_call_id).toBe('call-9')
      expect(tool?.content).toContain('src/')
      return new Response(
        'data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const opts = {
      provider: 'codearts',
      model: 'GLM-5.2',
      messages: [
        { role: 'assistant', content: [
          { type: 'tool-call', id: 'call-9', name: 'bash', arguments: '{"command":"ls"}' },
        ] },
        { role: 'user', content: [
          { type: 'tool-result', toolCallId: 'call-9', content: [{ type: 'text', text: 'src/ lib/' }] },
        ] },
      ],
      tools: [{ name: 'bash', description: 'Run a shell command', parameters: {} }],
      signal: new AbortController().signal,
    } as never
    for await (const _ of adapter.stream(opts)) { /* drain */ }
    expect(fetchImpl).toHaveBeenCalled()
  })
})
