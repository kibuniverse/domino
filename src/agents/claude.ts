import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, realpath, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { query } from '@anthropic-ai/claude-agent-sdk'
import type { HookCallback, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

import { DominoError, errorMessage } from '../core/types'
import type { AgentAdapter, AgentInput, Diagnostic } from '../core/types'
import { CLAUDE_FILE_TOOLS, ClaudeFilePolicy } from './claude-policy'

export interface ClaudeOptions {
  executable?: string
  configDir?: string
  model?: string
  effort?: 'low' | 'medium' | 'high'
  maxTurns?: number
}
const execute = promisify(execFile)
async function executablePath(executable: string) {
  if (executable.includes('/') || executable.includes('\\')) return realpath(resolve(executable))
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(directory, executable)
    try {
      await access(candidate, constants.X_OK)
      return await realpath(candidate)
    } catch {
      /* Continue through PATH. */
    }
  }
  throw new DominoError('EXECUTABLE_NOT_FOUND', `找不到可执行文件 ${executable}。`)
}
const ROUTING_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_MODEL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
])
function routingKey(key: string) {
  return ROUTING_KEYS.has(key) || /^ANTHROPIC_DEFAULT_[A-Z]+_MODEL(?:_NAME)?$/.test(key)
}
async function environment(
  configDir?: string,
): Promise<{ env: Record<string, string>; model?: string }> {
  const env: Record<string, string> = {
    CLAUDE_AGENT_SDK_CLIENT_APP: 'domino/0.1.0',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_ATTACHMENTS: '1',
  }
  const directory = resolve(
    configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
  )
  let model: string | undefined
  try {
    const settings = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'))
    // Reuse only credential/provider routing. Never pass the user's settings,
    // permissions, shell hooks, plugins or project overrides to this session.
    if (settings.env && typeof settings.env === 'object')
      for (const [key, value] of Object.entries(settings.env))
        if (routingKey(key) && typeof value === 'string') env[key] = value
    if (typeof settings.model === 'string') model = settings.model
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new DominoError(
        'CLAUDE_CONFIG_INVALID',
        '无法读取 Claude 用户配置中的认证和模型路由字段。请检查 settings.json。',
      )
  }
  for (const [key, value] of Object.entries(process.env))
    if (
      value &&
      (routingKey(key) ||
        ['PATH', 'HOME', 'USER', 'LANG', 'SHELL', 'TMPDIR', 'SystemRoot'].includes(key))
    )
      env[key] = value
  if (configDir || process.env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = directory
  return { env, model }
}
export class ClaudeAdapter implements AgentAdapter {
  id = 'claude'
  constructor(private options: ClaudeOptions = {}) {
    if (
      options.maxTurns !== undefined &&
      (!Number.isInteger(options.maxTurns) || options.maxTurns < 1 || options.maxTurns > 100)
    )
      throw new DominoError('INVALID_CONFIG', 'Claude maxTurns 必须是 1 到 100 的整数。')
  }
  async check(): Promise<Diagnostic> {
    let env: Record<string, string>
    try {
      env = (await environment(this.options.configDir)).env
    } catch (error) {
      return { ready: false, message: errorMessage(error) }
    }
    let executable: string
    let version: string
    try {
      executable = await executablePath(this.options.executable ?? 'claude')
      version = (await execute(executable, ['--version'], { timeout: 10000, env })).stdout.trim()
    } catch {
      return {
        ready: false,
        message: '找不到 Claude Code。安装 Claude Code，并检查 executable 配置和 PATH。',
      }
    }
    const match = version.match(/(\d+)\.(\d+)\.(\d+)/)
    if (
      !match ||
      Number(match[1]) < 2 ||
      (Number(match[1]) === 2 &&
        (Number(match[2]) < 1 || (Number(match[2]) === 1 && Number(match[3]) < 287)))
    )
      return {
        ready: false,
        message: `需要 Claude Code 2.1.287 或更新版本（当前 ${version}），以确认 SDK 文件权限 hook 已注册。`,
      }
    try {
      const auth = JSON.parse(
        (await execute(executable, ['auth', 'status', '--json'], { timeout: 10000, env })).stdout,
      )
      if (!auth.loggedIn) throw new Error('Not logged in')
      return { ready: true, message: `Claude Agent SDK · ${version} · 已登录 · 副本文件工具模式` }
    } catch {
      return {
        ready: false,
        message:
          'Claude Code 未登录或凭证不可用。运行 claude auth login，或设置 ANTHROPIC_API_KEY。',
      }
    }
  }
  async run(input: AgentInput): Promise<void> {
    if (input.signal.aborted) throw new DominoError('CANCELLED', '任务已取消。')
    const workspace = await realpath(input.workspaceRoot)
    const executable = await executablePath(this.options.executable ?? 'claude')
    const { env, model } = await environment(this.options.configDir)
    const selectedModel = this.options.model ?? env.ANTHROPIC_MODEL ?? model
    const policy = new ClaudeFilePolicy(workspace, input.writableDirectories)
    const controller = new AbortController()
    const abort = () => controller.abort()
    input.signal.addEventListener('abort', abort, { once: true })
    if (input.signal.aborted) controller.abort()
    let releasePrompt!: () => void
    const gate = new Promise<void>((resolve) => {
      releasePrompt = resolve
    })
    async function* prompt(): AsyncGenerator<SDKUserMessage> {
      await gate
      if (!controller.signal.aborted)
        yield {
          type: 'user',
          message: { role: 'user', content: input.prompt },
          parent_tool_use_id: null,
          session_id: '',
        }
    }
    const hook: HookCallback = async (data) => {
      if (data.hook_event_name !== 'PreToolUse') return {}
      try {
        if (controller.signal.aborted) throw new DominoError('CANCELLED', '任务已取消。')
        const updatedInput = await policy.authorize(data.tool_name, data.tool_input)
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            updatedInput,
          },
        }
      } catch (error) {
        const reason = errorMessage(error)
        input.emit({ type: 'tool', text: `Claude 工具已拒绝：${reason}` })
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          },
        }
      }
    }
    let session: Query | undefined
    try {
      session = query({
        prompt: prompt(),
        options: {
          cwd: workspace,
          pathToClaudeCodeExecutable: executable,
          env,
          abortController: controller,
          tools: [...CLAUDE_FILE_TOOLS],
          permissionMode: 'dontAsk',
          permissionPrompts: 'none',
          extraArgs: { 'safe-mode': null, restricted: null },
          settings: {
            enabledPlugins: {
              'cc-plugin-agents-md@builtin': false,
              'cc-plugin-plugin-authoring@builtin': false,
            },
          },
          settingSources: [],
          plugins: [],
          skills: [],
          mcpServers: {},
          strictMcpConfig: true,
          persistSession: false,
          hooks: { PreToolUse: [{ hooks: [hook], timeout: 10 }] },
          maxTurns: this.options.maxTurns ?? 30,
          effort: this.options.effort ?? 'low',
          systemPrompt:
            'You are a frontend coding agent editing an isolated source copy. Use only Read, Glob, Grep, Edit and Write. Bash, external tools, network tools, subagents and permission expansion are unavailable. Preserve unrelated code. Do not claim tests or browser verification. The host validates and applies changes after you finish.',
          ...(selectedModel ? { model: selectedModel } : {}),
        },
      })
      // Hold the user prompt until the CLI confirms our per-tool gate was installed.
      if ((await session.initializationResult()).hooks_applied !== true)
        throw new DominoError(
          'CLAUDE_POLICY_UNAVAILABLE',
          'Claude Code 未确认文件权限 hook 已注册，已拒绝执行。',
        )
      releasePrompt()
      let completed = false
      let lastText = ''
      for await (const message of session) {
        if (message.type === 'system' && message.subtype === 'init') {
          const extra = message.tools.filter((tool) => !CLAUDE_FILE_TOOLS.includes(tool))
          if (extra.length || message.mcp_servers.length || message.plugins.length)
            throw new DominoError(
              'CLAUDE_POLICY_UNAVAILABLE',
              `Claude Code 启用了未授权工具或插件（${[...extra, ...message.mcp_servers.map((server) => `MCP:${server.name}:${server.status}`), ...message.plugins.map((plugin) => `plugin:${plugin.name}`)].join(', ')}），已停止执行。`,
            )
        }
        if (message.type === 'system' && message.subtype === 'api_retry')
          input.emit({
            type: 'message',
            text: `Claude 请求重试 ${message.attempt}/${message.max_retries}：${message.error}`,
          })
        if (message.type === 'assistant') {
          if (message.error)
            throw new DominoError('CLAUDE_REQUEST_FAILED', `Claude 请求失败：${message.error}`)
          for (const block of message.message.content) {
            if (block.type === 'text') {
              lastText = block.text
              input.emit({ type: 'message', text: block.text })
            }
            if (block.type === 'tool_use')
              input.emit({ type: 'tool', text: `Claude 正在使用 ${block.name}` })
          }
        }
        if (message.type === 'user' && Array.isArray(message.message.content))
          for (const block of message.message.content)
            if (block.type === 'tool_result')
              input.emit({
                type: 'tool',
                text: `Claude 工具${block.is_error ? '失败' : '完成'}${typeof block.content === 'string' ? `：${block.content.slice(0, 1200)}` : ''}`,
              })
        if (message.type === 'result') {
          if (message.subtype !== 'success' || message.is_error)
            throw new DominoError(
              'CLAUDE_TURN_FAILED',
              message.subtype === 'success' ? message.result : message.errors.join('\n'),
            )
          completed = true
          if (message.result && message.result !== lastText)
            input.emit({ type: 'message', text: message.result })
          break
        }
      }
      if (!completed)
        throw new DominoError('CLAUDE_INCOMPLETE', 'Claude 事件流结束，但未确认任务完成。')
      if (controller.signal.aborted) throw new DominoError('CANCELLED', 'Claude 已停止。')
    } catch (error) {
      if (controller.signal.aborted) throw new DominoError('CANCELLED', 'Claude 已停止。')
      throw error
    } finally {
      controller.abort()
      releasePrompt()
      // close() is fire-and-forget. Await disposal so TaskManager cannot inspect
      // or remove the candidate copy while the CLI is still shutting down.
      try {
        await session?.[Symbol.asyncDispose]()
      } finally {
        input.signal.removeEventListener('abort', abort)
      }
    }
  }
}
