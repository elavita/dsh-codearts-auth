import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  attributionHeaders, CallId, LlmAdapter, LlmError,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { signRequestHuawei } from './sign.js'
import type { CodeArtsCredential } from './types.js'

export const CHAT_API_BASE = 'https://snap-access.cn-north-4.myhuaweicloud.com/api/v2'
export const PROVIDER = 'codearts'

const DEFAULT_MODELS: readonly string[] = ['GLM-5.2', 'GLM-5.1', 'GLM-5']

export interface CodeArtsAdapterOptions {
  credentialRef: CredentialRef
  resolveCredential: () => Promise<CodeArtsCredential | undefined>
  refresh: () => Promise<void>
  fetchImpl?: typeof fetch
  chatId?: string
  sessionId?: string
}

/**
 * 将消息内容载荷展平为纯文本字符串。Harness 消息
 * 以 OpenAI 风格的块数组形式携带内容（`[{type:'text',...}]`，且
 * 助手历史可能包含 `{type:'reasoning',...}` 块）；CodeArts
 * 端点会拒绝非 `text` 块类型并返回空流，因此只保留
 * `text` 块并拼接。
 */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: string; text: unknown } =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text')
    .map((block) => String(block.text))
    .join('')
}

/**
 * 将 harness 对话消息序列化为 CodeArts chat-completions 的传输
 * 格式。助手的 `tool-call` 块转换为 `tool_calls` 字段；工具
 * 结果（搭载在 harness 用户消息中）展开为独立的
 * `{role: 'tool'}` 消息，使模型能看到其调用的返回值。
 * 非文本块（推理、图片）被丢弃，与端点接受的格式一致。
 */
function serializeMessages(messages: readonly { role: string; content: unknown }[]): Array<Record<string, unknown>> {
  const wire: Array<Record<string, unknown>> = []
  for (const message of messages) {
    if (message.role === 'assistant') {
      const content = Array.isArray(message.content) ? message.content : []
      const toolCalls = content
        .filter((block): block is { type: string; id: unknown; name: unknown; arguments: unknown } =>
          typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-call')
        .map((block) => ({
          id: String(block.id),
          type: 'function' as const,
          function: { name: String(block.name), arguments: String(block.arguments) },
        }))
      wire.push({
        role: 'assistant',
        content: contentToText(content),
        ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
      })
      continue
    }
    if (message.role === 'system') {
      wire.push({ role: 'system', content: contentToText(message.content) })
      continue
    }
    // user 角色：工具结果搭载在 harness 用户消息中；将每个展开为
    // 独立的 role:'tool' 传输消息，与 deepseek 适配器的行为一致。
    const content = Array.isArray(message.content) ? message.content : []
    const toolResults = content.filter((block): block is { type: string; toolCallId: unknown; content: unknown } =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-result')
    const text = contentToText(content)
    if (text.length > 0 || toolResults.length === 0) wire.push({ role: 'user', content: text })
    for (const result of toolResults) {
      wire.push({
        role: 'tool',
        tool_call_id: String(result.toolCallId),
        content: contentToText(result.content) || '(no output)',
      })
    }
  }
  return wire
}

/**
 * CodeArts 并发排队端点。当后端按账户的会话
 * 并发上限达到时，chat completions 请求会以
 * `TM.00001041`（"并发会话数已达上限"）失败，调用方需轮询
 * 排队状态端点，直到后端再次允许该会话。
 */
export const QUEUE_STATUS_BASE = 'https://snap-access.cn-north-4.myhuaweicloud.com/api/v1/queue/status'

/** 在 CodeArts 队列中等待时的轮询间隔。 */
const QUEUE_RETRY_DELAY_MS = 10_000
/** 轮询上限：180 × 10 秒 = 30 分钟，与 deveco-code 参考实现一致。 */
const QUEUE_MAX_ATTEMPTS = 180

/** CodeArts 后端返回的一次排队状态响应。 */
export interface CodeArtsQueueStatus {
  readonly status: 'waiting' | 'working' | 'error' | 'queue_full'
  readonly queuePosition: number
  readonly message: string
}

/** 判断 HTTP 错误体是否表示 CodeArts 并发排队限流。 */
function isQueueError(status: number, body: string): boolean {
  return status === 400
    && (body.includes('TM.00001041')
      || /peak\s+usage|try\s+again\s+after|peak\s+hours/i.test(body)
      || /high\s+demand|too\s+many\s+requests/i.test(body))
}

/** 可中止的休眠；当信号中止时立即 resolve。 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const onAbort = (): void => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 兼容 OpenAI 格式的 CodeArts 模型适配器，使用华为请求签名。 */
export class CodeArtsAdapter extends LlmAdapter {
  private readonly fetchImpl: typeof fetch
  private readonly chatId: string
  private readonly sessionId: string

  constructor(private readonly options: CodeArtsAdapterOptions) {
    super()
    this.fetchImpl = options.fetchImpl ?? fetch
    this.chatId = options.chatId ?? crypto.randomUUID().replace(/-/g, '')
    this.sessionId = options.sessionId ?? crypto.randomUUID().replace(/-/g, '')
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'CodeArts Agent' }
  }

  listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(DEFAULT_MODELS.map((id) => ({ provider: PROVIDER, id, name: id, inputModalities: ['text'] })))
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    let credential = await this.options.resolveCredential()
    if (credential === undefined || Date.parse(credential.expires_at) <= Date.now()) {
      await this.options.refresh()
      credential = await this.options.resolveCredential()
    }
    if (credential === undefined || !credential.access_key_id || !credential.secret_access_key || !credential.security_token) {
      throw new LlmError('codearts: no usable credential; log in first', 'MISSING_CREDENTIAL')
    }

    const messages = serializeMessages(options.messages)
    // 将 harness 工具模式以 OpenAI function 格式告知模型，
    // 与 deepseek 适配器序列化 GenerateOptions.tools 的方式一致。
    const tools = options.tools?.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }))
    const body = JSON.stringify({
      model: options.model,
      messages,
      stream: true,
      // 对齐 CodeArts Agent IDE 请求体（deveco-code 内核日志实证）：
      // tool_stream=true 让后端将超大工具调用参数（如大文件 file_write）
      // 分段流式传输，避免单次 SSE 事件过大导致连接被掐断
      // （error decoding response body）。
      tool_stream: true,
      // 输出上限（对齐 deveco-code-rust 参考实现 codearts.rs 的 max_tokens 配置）：
      // 大文件 write 工具参数（如 1000-2000+ 行文档）需要数万 token 的生成空间，
      // 若沿用后端默认输出上限，参数 JSON 会在中途被截断成非法 JSON，harness
      // 工具校验报 `invalid arguments: "arguments" must be an object`。
      // 参考实现 e2e 实测：65536 可用，131072 反而触发空流被后端拒绝；
      // 显式传入的 options.maxTokens 优先，未设置时默认 65536。
      max_tokens: options.maxTokens ?? 65536,
      ...tools !== undefined && tools.length > 0 ? { tools } : {},
    })
    const url = `${CHAT_API_BASE}/chat/completions`

    // CodeArts 按账户限制并发：当会话上限
    // 达到时请求以 TM.00001041 失败，后端期望
    // 调用方轮询其排队状态端点，直到会话被允许。
    // 在排队期间重试 chat 请求，上限为 30 分钟。
    let response: Response
    for (;;) {
      const signed = await signRequestHuawei(
        credential.access_key_id,
        credential.secret_access_key,
        credential.security_token,
        'POST',
        url,
        new TextEncoder().encode(body),
      )
      const headers = new Headers(attributionHeaders())
      signed.forEach((value, key) => { if (key !== 'content-type') headers.set(key, value) })
      headers.set('Content-Type', 'application/json')
      headers.set('Chat-Id', this.chatId)
      headers.set('Session-Id', this.sessionId)
      headers.set('lang', 'en')

      response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        signal: options.signal,
      })
      if (response.ok) break
      const errorText = await response.text().catch(() => '')
      if (!isQueueError(response.status, errorText)) {
        // 与 deepseek 适配器的 httpErrorCode 词汇保持一致。
        const code = response.status === 401 || response.status === 403 ? 'AUTH'
          : response.status >= 500 ? 'SERVER'
          : `HTTP_${response.status}`
        throw new LlmError(`codearts: model request failed with HTTP ${response.status}`, code)
      }
      const admitted = await this.waitForQueueAdmission(credential, options.model, options.signal)
      if (admitted.kind === 'error') {
        throw new LlmError(`codearts: ${admitted.message}`, 'QUEUE')
      }
      // admitted.kind === 'working' → 重试 chat 请求
    }
    if (!response.body) throw new LlmError('codearts: empty model response body', 'EMPTY_RESPONSE')

    // 每个块的组装状态：文本 / 推理 / 工具调用各自拥有唯一
    // 索引，与 harness StreamChunk→ContentBlock 契约一致。
    const blocks: Array<{
      index: number
      kind: 'text' | 'reasoning'
      text: string
    }> = []
    const toolCalls = new Map<number, { index: number; text: string; callId?: string; name?: string }>()
    const toolOrder: number[] = []
    let nextIndex = 0
    let buffer = ''
    let streamEnded = false
    let finishReason: 'stop' | 'tool_calls' | 'length' | undefined
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    try {
      for (;;) {
        if (streamEnded) break
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newline: number
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') {
            streamEnded = true
            break
          }
          let data: {
            choices?: Array<{
              delta?: {
                content?: string
                reasoning_content?: string
                tool_calls?: Array<{
                  index?: number
                  id?: string
                  function?: { name?: string; arguments?: string }
                }>
              }
              finish_reason?: string
            }>
            usage?: Record<string, number>
          }
          try {
            data = JSON.parse(payload)
          } catch {
            continue
          }
          const choice = data.choices?.[0]
          const delta = choice?.delta
          if (typeof choice?.finish_reason === 'string') {
            finishReason = choice.finish_reason as 'stop' | 'tool_calls' | 'length'
          }
          if (delta?.content) {
            let block = blocks.find(candidate => candidate.kind === 'text')
            if (block === undefined) {
              block = { index: nextIndex++, kind: 'text', text: '' }
              blocks.push(block)
              yield { type: 'block-start', index: block.index, blockType: 'text' }
            }
            block.text += delta.content
            yield { type: 'text-delta', index: block.index, text: delta.content }
          }
          if (delta?.reasoning_content) {
            let block = blocks.find(candidate => candidate.kind === 'reasoning')
            if (block === undefined) {
              block = { index: nextIndex++, kind: 'reasoning', text: '' }
              blocks.push(block)
              yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
            }
            block.text += delta.reasoning_content
            yield { type: 'reasoning-delta', index: block.index, text: delta.reasoning_content }
          }
          for (const call of delta?.tool_calls ?? []) {
            const wireIndex = call.index ?? 0
            let block = toolCalls.get(wireIndex)
            if (block === undefined) {
              block = { index: nextIndex++, text: '' }
              toolCalls.set(wireIndex, block)
              toolOrder.push(block.index)
              yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
            }
            if (call.id !== undefined) block.callId = call.id
            if (call.function?.name !== undefined) block.name = call.function.name
            const fragment = call.function?.arguments ?? ''
            block.text += fragment
            yield {
              type: 'tool-call-delta',
              index: block.index,
              id: CallId(block.callId ?? ''),
              ...block.name !== undefined ? { name: block.name } : {},
              argumentsDelta: fragment,
            }
          }
          if (data.usage) {
            yield {
              type: 'usage',
              usage: {
                inputTokens: data.usage.prompt_tokens ?? 0,
                outputTokens: data.usage.completion_tokens ?? 0,
              },
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
    // 按创建顺序关闭每个块。CodeArts GLM 端点有时
    // 将整个回答作为 reasoning_content 发出且 content 为空：回退到
    // 推理作为可见文本，确保用户始终能收到回复。
    const textBlock = blocks.find(block => block.kind === 'text')
    const reasoningBlock = blocks.find(block => block.kind === 'reasoning')
    const visible = textBlock !== undefined && textBlock.text !== ''
      ? textBlock.text
      : reasoningBlock !== undefined ? reasoningBlock.text : ''
    for (const index of toolOrder) {
      const block = [...toolCalls.values()].find(candidate => candidate.index === index)!
      yield {
        type: 'block-end',
        index,
        block: {
          type: 'tool-call',
          id: CallId(block.callId ?? ''),
          name: block.name ?? '',
          arguments: block.text,
        },
      }
    }
    if (textBlock !== undefined || visible !== '') {
      yield { type: 'block-end', index: textBlock?.index ?? nextIndex, block: { type: 'text', text: visible } }
    }
    if (reasoningBlock !== undefined && reasoningBlock.text !== '') {
      yield { type: 'block-end', index: reasoningBlock.index, block: { type: 'reasoning', text: reasoningBlock.text } }
    }
    const reason = finishReason === 'tool_calls' || toolOrder.length > 0
      ? { kind: 'tool-calls' as const }
      : finishReason === 'length'
        ? { kind: 'max-tokens' as const }
        : { kind: 'stop' as const }
    yield { type: 'finish', reason }
  }

  /**
   * 轮询 CodeArts 排队状态端点，直到后端允许该
   * 会话（状态为 `working`）或报告终态。任务 id 为
   * 本适配器自身的会话 id —— 即 chat 请求携带的
   * `Session-Id` 头，以便后端关联排队的会话。
   * @param credential - 用于签名状态请求的 AK/SK/SecurityToken。
   * @param model - 模型 id，作为 `model` 查询参数回传。
   * @param signal - 轮询循环的取消信号。
   * @returns `working` 表示可重试 chat 请求，或返回终态错误消息。
   */
  private async waitForQueueAdmission(
    credential: CodeArtsCredential,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ kind: 'working' } | { kind: 'error'; message: string }> {
    for (let attempt = 0; attempt < QUEUE_MAX_ATTEMPTS; attempt++) {
      if (signal?.aborted) return { kind: 'error', message: 'request aborted while waiting in queue' }
      const status = await this.queryQueueStatus(credential, model, signal)
      if (status === undefined) {
        // 状态端点不可达/空 —— 继续轮询而非失败。
        await delay(QUEUE_RETRY_DELAY_MS, signal)
        continue
      }
      if (status.status === 'working') return { kind: 'working' }
      if (status.status === 'error' || status.status === 'queue_full') {
        return { kind: 'error', message: status.message || `queue status: ${status.status}` }
      }
      await delay(QUEUE_RETRY_DELAY_MS, signal)
    }
    return { kind: 'error', message: 'queue wait timed out after 30 minutes' }
  }

  /**
   * 查询某个会话的 CodeArts 并发队列状态。该端点
   * 与 chat API 一样使用 AK/SK 签名；GET 不携带请求体，因此无 content-type。
   * @param credential - 用于签名请求的 AK/SK/SecurityToken。
   * @param model - 模型 id，作为 `model` 查询参数回传。
   * @param signal - 状态请求的取消信号。
   * @returns 解析后的排队状态，或当端点不可达
   *   或返回无法识别的载荷时返回 `undefined`。
   */
  private async queryQueueStatus(
    credential: CodeArtsCredential,
    model: string,
    signal?: AbortSignal,
  ): Promise<CodeArtsQueueStatus | undefined> {
    const url = `${QUEUE_STATUS_BASE}?model=${encodeURIComponent(model)}&task_id=${encodeURIComponent(this.sessionId)}`
    const signed = await signRequestHuawei(
      credential.access_key_id,
      credential.secret_access_key,
      credential.security_token,
      'GET',
      url,
      new Uint8Array(),
    )
    const headers = new Headers()
    signed.forEach((value, key) => { if (key !== 'content-type') headers.set(key, value) })
    headers.set('x-snap-traceid', crypto.randomUUID())
    headers.set('Agent-Type', 'INFERHUB_AGENT')
    headers.set('X-Language', 'en')
    let response: Response
    try {
      response = await this.fetchImpl(url, { method: 'GET', headers, signal })
    } catch {
      return undefined
    }
    if (response.status !== 200) return undefined
    let body: Record<string, unknown>
    try {
      body = await response.json() as Record<string, unknown>
    } catch {
      return undefined
    }
    const status = body.status
    if (status !== 'waiting' && status !== 'working' && status !== 'error' && status !== 'queue_full') return undefined
    return {
      status,
      queuePosition: Number(body.queue_position ?? -1),
      message: typeof body.message === 'string' ? body.message : '',
    }
  }
}

/** 在 ctx.llm 上注册 codearts 提供商路由和适配器。 */
export function registerCodeArtsLlm(ctx: Context, options: CodeArtsAdapterOptions): void {
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'CodeArts Agent', settingsNs: 'llm-codearts', settingsPath: [] },
  ])
  ctx.llm.registerAdapter([PROVIDER], new CodeArtsAdapter(options))
}
