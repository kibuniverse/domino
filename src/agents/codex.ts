import { Codex } from '@openai/codex-sdk'
import type { CodexOptions as SdkOptions } from '@openai/codex-sdk'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, symlink, lstat, rm, realpath, access, writeFile, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve, delimiter } from 'node:path'
import { constants } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { DominoError } from '../core/types'
import { validateDirectories } from '../core/files'
import type { AgentAdapter, AgentInput, Diagnostic } from '../core/types'

export interface CodexOptions { executable?: string; model?: string; authHome?: string; effort?: 'low' | 'medium' | 'high' }
const execute = promisify(execFile)

async function executablePath(executable: string): Promise<string> {
  if (executable.includes('/') || executable.includes('\\')) return realpath(resolve(executable))
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(directory, executable)
    try { await access(candidate, constants.X_OK); return await realpath(candidate) } catch { /* Continue through PATH. */ }
  }
  throw new DominoError('EXECUTABLE_NOT_FOUND', `找不到可执行文件 ${executable}。`)
}

function environment(home: string): Record<string, string> {
  const env: Record<string, string> = { CODEX_HOME: home }
  for (const key of ['PATH', 'HOME', 'USER', 'LANG', 'SHELL', 'TMPDIR', 'SystemRoot', 'OPENAI_API_KEY', 'CODEX_API_KEY']) if (process.env[key]) env[key] = process.env[key]!
  return env
}

// Raw TOML preserves absolute filesystem keys; SDK dotted config would split them.
function toml(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).map(([key, val]) => `${JSON.stringify(key)}=${toml(val)}`).join(',')}}`
  throw new Error('Unsupported TOML config value')
}

export class CodexAdapter implements AgentAdapter {
  id = 'codex'
  constructor(private options: CodexOptions = {}) {}
  private async isolatedHome() {
    const home = await mkdtemp(join(tmpdir(), 'domino-auth-'))
    const auth = join(this.options.authHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json')
    try { await lstat(auth); await symlink(auth, join(home, 'auth.json')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { await rm(home, { recursive: true, force: true }); throw error } }
    return home
  }
  async check(): Promise<Diagnostic> {
    if (process.platform === 'win32') return { ready: false, message: '第一版尚未验证 Windows，请在 macOS 或 Linux 使用。' }
    let executable: string
    let version: string
    try {
      executable = await executablePath(this.options.executable ?? 'codex')
      version = (await execute(executable, ['--version'], { timeout: 10000 })).stdout.trim()
    } catch { return { ready: false, message: '找不到 Codex CLI。安装 Codex，并确认 executable 配置和 PATH。' } }
    const match = version.match(/(\d+)\.(\d+)\.(\d+)/)
    if (!match || (Number(match[1]) === 0 && Number(match[2]) < 160)) return { ready: false, message: `需要 Codex CLI 0.160.0 或更新版本（当前 ${version}），以支持权限 profile。` }
    const home = await this.isolatedHome()
    try {
      await execute(executable, ['-c', 'cli_auth_credentials_store="file"', 'login', 'status'], { env: environment(home), cwd: home, timeout: 10000 })
      return { ready: true, message: `Codex SDK · ${version} · 已登录 · 隔离源码副本执行` }
    } catch { return { ready: false, message: 'Codex 未登录或无法读取凭证。运行 codex login（文件凭证模式），或配置 CODEX_API_KEY。' } }
    finally { await rm(home, { recursive: true, force: true }) }
  }
  async run(input: AgentInput): Promise<void> {
    if (input.signal.aborted) throw new DominoError('CANCELLED', '任务已取消。')
    const directories = validateDirectories(input.writableDirectories)
    const workspace = await realpath(input.workspaceRoot)
    const executable = await executablePath(this.options.executable ?? 'codex')
    const home = await this.isolatedHome()
    try {
      const temporary = join(home, 'tool-tmp')
      await mkdir(temporary)
      const filesystem: Record<string, string> = { ':minimal': 'read', [executable]: 'read', [temporary]: 'write', [workspace]: 'read' }
      for (const directory of directories) filesystem[join(workspace, directory)] = 'write'
      const permission = `permissions.domino=${toml({ filesystem, network: { enabled: false } })}`
      const env = environment(home)
      // Local CLI diagnostics/probes do not start a model turn. All agent interaction
      // and JSONL event handling are owned by the official TypeScript SDK below.
      await this.probe(executable, home, workspace, directories[0], permission, env, input.signal)
      const config: SdkOptions['config'] = {
        cli_auth_credentials_store: 'file',
        default_permissions: 'domino',
        approval_policy: 'never',
        web_search: 'disabled',
        features: { apps: false, plugins: false, multi_agent: false },
        shell_environment_policy: { inherit: 'none', set: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/nonexistent', TMPDIR: temporary } },
      }
      const codex = new Codex({ codexPathOverride: executable, env, config, configOverrides: [permission] })
      // Do not pass sandboxMode: it would override the restricted named profile.
      const thread = codex.startThread({
        workingDirectory: workspace,
        skipGitRepoCheck: true,
        approvalPolicy: 'never',
        webSearchMode: 'disabled',
        modelReasoningEffort: this.options.effort ?? 'low',
        ...(this.options.model ? { model: this.options.model } : {}),
      })
      const { events } = await thread.runStreamed(input.prompt, { signal: input.signal })
      let completed = false
      let lastError: string | undefined
      for await (const event of events) {
        if (event.type === 'item.started' && ['command_execution', 'file_change'].includes(event.item.type)) input.emit({ type: 'tool', text: event.item.type === 'file_change' ? 'Codex 正在编辑候选源码' : 'Codex 正在检查源码' })
        if (event.type === 'item.completed') {
          const item = event.item
          if (item.type === 'agent_message') input.emit({ type: 'message', text: item.text })
          if (item.type === 'command_execution') input.emit({ type: 'tool', text: `Codex 检查结束：${item.status}${typeof item.exit_code === 'number' ? ` (exit ${item.exit_code})` : ''}${item.aggregated_output ? `\n${item.aggregated_output.slice(0, 1200)}` : ''}` })
          if (item.type === 'file_change') input.emit({ type: 'tool', text: `Codex 编辑结束：${item.status}` })
          if (item.type === 'error') input.emit({ type: 'message', text: `Codex 诊断：${item.message}` })
        }
        if (event.type === 'error') { lastError = event.message; input.emit({ type: 'message', text: `Codex 诊断：${event.message}` }) }
        if (event.type === 'turn.failed') throw new DominoError('CODEX_TURN_FAILED', event.error.message)
        if (event.type === 'turn.completed') completed = true
      }
      if (!completed) throw new DominoError('CODEX_INCOMPLETE', lastError ?? 'Codex 事件流结束，但未确认任务完成。')
      if (input.signal.aborted) throw new DominoError('CANCELLED', 'Agent 已停止。')
    } catch (error) {
      if (input.signal.aborted) throw new DominoError('CANCELLED', 'Agent 已停止。')
      throw error
    } finally { await rm(home, { recursive: true, force: true }) }
  }
  private async probe(executable: string, home: string, workspace: string, directory: string, permission: string, env: Record<string, string>, signal: AbortSignal) {
    const sentinel = join(home, 'sandbox-sentinel')
    await writeFile(sentinel, 'domino sandbox probe', { mode: 0o600 })
    await mkdir(join(workspace, directory), { recursive: true })
    const writable = join(workspace, directory, `.domino-probe-${randomUUID()}`)
    const run = async (command: string[]): Promise<boolean> => {
      try {
        await execute(executable, ['sandbox', '-c', permission, '-c', 'default_permissions="domino"', '-P', 'domino', '-C', workspace, '--', ...command], { env, cwd: workspace, signal, timeout: 10000, maxBuffer: 1024 * 1024 })
        return true
      } catch (error) {
        if (signal.aborted || typeof (error as { code?: string | number }).code !== 'number') throw error
        return false
      }
    }
    try {
      const allowed = await run(['/bin/sh', '-c', 'printf domino > "$1"', 'domino', writable])
      const deniedRead = await run(['/bin/cat', sentinel])
      const deniedWrite = await run(['/bin/sh', '-c', 'printf domino > "$1"', 'domino', join(home, 'denied-write')])
      if (!allowed || deniedRead || deniedWrite) throw new DominoError('SANDBOX_UNAVAILABLE', '实际沙箱未通过允许写入和拒绝越界读写检查，已拒绝执行。')
    } finally { await rm(writable, { force: true }) }
  }
}
