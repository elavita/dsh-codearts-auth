import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { apply } from '../../src/index.js'
import { runLoginFlow } from '../../src/login.js'
import { CodeArtsAuth } from '../../src/service.js'

vi.mock('../../src/login.js', () => ({
  runLoginFlow: vi.fn(),
}))

const mockedRunLoginFlow = vi.mocked(runLoginFlow)

class FakeCredentials {
  private store = new Map<string, string>()
  async resolve(ref: string) {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: string) {
    return { configured: this.store.has(ref), source: this.store.has(ref) ? 'fake' : undefined, writable: true }
  }
  async set(ref: string, value: string) { this.store.set(ref, value) }
  async unset(ref: string) { this.store.delete(ref) }
}

class FakeCommands {
  readonly definitions: CommandDefinition[] = []
  register(definition: CommandDefinition): () => void {
    this.definitions.push(definition)
    return () => {}
  }
}

class FakeLlm {
  readonly providers: string[] = []
  readonly adapters: string[] = []
  registerConfigurableProviders(entries: Array<{ provider: string }>): { replace: () => void } {
    for (const entry of entries) this.providers.push(entry.provider)
    return { replace: () => {} }
  }
  registerAdapter(providers: string[], _adapter: unknown): { replace: () => void } {
    this.adapters.push(...providers)
    return { replace: () => {} }
  }
}

function makeContext(): { ctx: Context; commands: FakeCommands; llm: FakeLlm } {
  const ctx = new Context()
  ctx.provide('credentials', new FakeCredentials() as never)
  const commands = new FakeCommands()
  ctx.provide('commands', commands as never)
  const llm = new FakeLlm()
  ctx.provide('llm', llm as never)
  return { ctx, commands, llm }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('plugin entry', () => {
  it('registers the codeartsAuth service and the codearts-login command', () => {
    const { ctx, commands } = makeContext()
    apply(ctx)
    expect(ctx.codeartsAuth).toBeInstanceOf(CodeArtsAuth)
    expect(commands.definitions.map((d) => d.name)).toContain('codearts-login')
  })

  it('command handler reports success with ref and expiry', async () => {
    mockedRunLoginFlow.mockResolvedValue({ access: 'cred', expires: 1234, loginUrl: 'https://login' })
    const { ctx, commands } = makeContext()
    apply(ctx)
    const login = commands.definitions.find((d) => d.name === 'codearts-login')!
    const result = await login.handler({
      commandId: 'cid' as never,
      agent: undefined as never,
      rawInput: '',
      signal: new AbortController().signal,
    })
    expect(result).toMatchObject({ kind: 'success' })
    expect((result as { text?: string }).text).toContain('CODEARTS_ACCESS_TOKEN')
  })

  it('command handler reports a failure as an error result', async () => {
    mockedRunLoginFlow.mockRejectedValue(new Error('CodeArts login timed out'))
    const { ctx, commands } = makeContext()
    apply(ctx)
    const login = commands.definitions.find((d) => d.name === 'codearts-login')!
    const result = await login.handler({
      commandId: 'cid' as never,
      agent: undefined as never,
      rawInput: '',
      signal: new AbortController().signal,
    })
    expect(result).toEqual({ kind: 'error', text: 'CodeArts login timed out' })
  })

  it('registers the codearts LLM route and the status/refresh commands', () => {
    const { ctx, commands, llm } = makeContext()
    apply(ctx)
    expect(llm.providers).toContain('codearts')
    expect(llm.adapters).toContain('codearts')
    const names = commands.definitions.map((d) => d.name)
    expect(names).toContain('codearts-status')
    expect(names).toContain('codearts-refresh')
  })

  it('codearts-status reports refreshability', async () => {
    mockedRunLoginFlow.mockResolvedValue({ access: 'cred', expires: 1234, loginUrl: 'https://login' })
    const { ctx, commands } = makeContext()
    apply(ctx)
    const status = commands.definitions.find((d) => d.name === 'codearts-status')!
    const result = await status.handler({
      commandId: 'cid' as never,
      agent: undefined as never,
      rawInput: '',
      signal: new AbortController().signal,
    })
    expect(result).toMatchObject({ kind: 'success' })
  })
})
