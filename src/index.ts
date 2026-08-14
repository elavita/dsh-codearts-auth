import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { registerCodeArtsLlm } from './llm-adapter.js'
import { CODEARTS_CREDENTIAL_REF, CodeArtsAuth } from './service.js'
import type { CodeArtsCredential } from './types.js'

export const name = 'codearts-auth'
export const inject = ['credentials', 'commands', 'llm']

/** 注册 codeartsAuth 服务、命令以及 codearts LLM 路由。 */
export function apply(ctx: Context): void {
  const service = new CodeArtsAuth(ctx)
  ctx.commands.register({
    name: 'codearts-login',
    description: '通过浏览器 OAuth 登录华为云 CodeArts',
    handler: async (): Promise<CommandResult> => {
      try {
        const result = await service.login()
        return {
          kind: 'success',
          text: `CodeArts 登录完成。凭据已存储于 ${String(result.ref)}；过期时间 ${new Date(result.expires).toISOString()}。`,
        }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })
  ctx.commands.register({
    name: 'codearts-status',
    description: '显示 CodeArts 登录状态及刷新能力',
    handler: async (): Promise<CommandResult> => {
      const status = await service.status()
      return {
        kind: 'success',
        text: [
          `已配置: ${status.configured}`,
          ...status.source === undefined ? [] : [`来源: ${status.source}`],
          ...status.expiresAt === undefined ? [] : [`过期时间: ${new Date(status.expiresAt).toISOString()}`],
          `可刷新: ${status.refreshable}`,
          ...status.refreshError === undefined ? [] : [`刷新错误: ${status.refreshError}`],
        ].join('\n'),
      }
    },
  })
  ctx.commands.register({
    name: 'codearts-refresh',
    description: '静默刷新 CodeArts 凭据',
    handler: async (): Promise<CommandResult> => {
      try {
        await service.refresh()
        const status = await service.status()
        return {
          kind: 'success',
          text: `CodeArts 凭据已刷新；过期时间 ${status.expiresAt === undefined ? '未知' : new Date(status.expiresAt).toISOString()}。`,
        }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })
  registerCodeArtsLlm(ctx, {
    credentialRef: credentialRef(CODEARTS_CREDENTIAL_REF),
    resolveCredential: async () => {
      const resolved = await ctx.credentials.resolve(credentialRef(CODEARTS_CREDENTIAL_REF))
      if (!resolved) return undefined
      try {
        return JSON.parse(resolved.value) as CodeArtsCredential
      } catch {
        return undefined
      }
    },
    refresh: () => service.refresh(),
  })
}
