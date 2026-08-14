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

  it('polls the queue status and retries the chat request when TM.00001041 admits working', async () => {
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
  })

  it('retries the chat request after a waiting queue status turns working', async () => {
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
    expect(calls.queue).toBe(2)
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
    }).rejects.toMatchObject({ code: 'HTTP_400' })
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
      }
      expect(sent.model).toBe('GLM-5.2')
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
