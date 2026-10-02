import type { AgentAdapter } from '../core/types'
import { DominoError } from '../core/types'
import type { CodexOptions } from './codex'
import type { ClaudeOptions } from './claude'

export type AgentConfig = (CodexOptions & { provider?: 'codex' }) | (ClaudeOptions & { provider: 'claude' }) | AgentAdapter

export async function createAgent(options?: AgentConfig): Promise<AgentAdapter> {
  if (options && 'run' in options) return options
  if (options?.provider === 'claude') {
    try { const { ClaudeAdapter } = await import('./claude'); return new ClaudeAdapter(options) }
    catch (error) { throw missingSdk(error, '@anthropic-ai/claude-agent-sdk') }
  }
  if (!options?.provider || options.provider === 'codex') {
    try { const { CodexAdapter } = await import('./codex'); return new CodexAdapter(options) }
    catch (error) { throw missingSdk(error, '@openai/codex-sdk') }
  }
  throw new DominoError('INVALID_CONFIG', '不支持的 Agent provider。请使用 codex、claude 或自定义 AgentAdapter。')
}

// Agent SDKs are optionalDependencies so installs only need the provider in use.
function missingSdk(error: unknown, sdk: string): unknown {
  return error instanceof Error && error.message.includes(`Cannot find package '${sdk}'`)
    ? new DominoError('AGENT_SDK_NOT_INSTALLED', `未安装 ${sdk}。请在项目中安装后重试：npm install ${sdk}`)
    : error
}
