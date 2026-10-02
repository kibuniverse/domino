import { lstat, readdir, realpath } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { editable, validateDirectories } from '../core/files'
import { within } from '../core/registry'
import { DominoError } from '../core/types'

export const CLAUDE_FILE_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write']
const METADATA = new Set(['package.json', 'tsconfig.json', 'AGENTS.md', 'README.md', 'index.html'])

async function stat(path: string) {
  try { return await lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
function glob(value: unknown) {
  if (typeof value !== 'string' || !value.length || value.length > 500 || value.includes('..') || /[~:\\\0\r\n()!]/.test(value) || /(?:^|[{,])\s*\//.test(value)) throw new DominoError('CLAUDE_TOOL_DENIED', '仅支持副本内的相对 glob 模式。')
}

// Native file tools run in the CLI process, not a Bash sandbox. Gate every call
// with PreToolUse, including calls that the CLI would otherwise auto-approve.
export class ClaudeFilePolicy {
  private directories: string[]
  constructor(private root: string, directories: string[]) { this.directories = validateDirectories(directories) }
  private async path(value: unknown, allowRoot = false) {
    if (typeof value !== 'string' || !value || value.length > 4000 || value.includes('\0')) throw new DominoError('CLAUDE_TOOL_DENIED', '无效文件路径。')
    const path = resolve(this.root, value)
    if (!within(this.root, path) || (!allowRoot && path === this.root)) throw new DominoError('CLAUDE_TOOL_DENIED', '拒绝访问源码副本之外的路径。')
    const rel = relative(this.root, path).split('\\').join('/')
    if (rel.split('/').some(part => part.startsWith('.'))) throw new DominoError('CLAUDE_TOOL_DENIED', '拒绝访问隐藏文件或目录。')
    let component = this.root
    for (const part of rel.split('/').filter(Boolean)) {
      component = join(component, part)
      const current = await stat(component)
      if (current?.isSymbolicLink() || (current && !within(this.root, await realpath(component)))) throw new DominoError('CLAUDE_TOOL_DENIED', '拒绝通过符号链接访问文件。')
    }
    return { path, rel, stat: await stat(path) }
  }
  private async tree(path: string) {
    const current = await stat(path)
    if (!current || current.isSymbolicLink()) throw new DominoError('CLAUDE_TOOL_DENIED', '搜索目录不存在或含符号链接。')
    if (current.isDirectory()) {
      for (const entry of await readdir(path)) await this.tree(join(path, entry))
    } else if (!current.isFile()) throw new DominoError('CLAUDE_TOOL_DENIED', '拒绝搜索特殊文件。')
  }
  async authorize(tool: string, value: unknown): Promise<Record<string, unknown>> {
    if (!CLAUDE_FILE_TOOLS.includes(tool) || !value || typeof value !== 'object' || Array.isArray(value)) throw new DominoError('CLAUDE_TOOL_DENIED', '当前 Claude 模式仅允许指定文件工具。')
    const input = value as Record<string, unknown>
    if (tool === 'Glob' || tool === 'Grep') {
      if (tool === 'Glob') glob(input.pattern)
      if (input.glob !== undefined) glob(input.glob)
      const target = await this.path(input.path ?? this.root, true)
      if (!target.stat || (tool === 'Glob' && !target.stat.isDirectory())) throw new DominoError('CLAUDE_TOOL_DENIED', '无效搜索路径。')
      if (target.path !== this.root && !this.directories.some(dir => target.rel === dir || target.rel.startsWith(`${dir}/`)) && !METADATA.has(target.rel)) throw new DominoError('CLAUDE_TOOL_DENIED', '搜索路径不在副本源码范围内。')
      await this.tree(target.path)
      return { ...input, path: target.path }
    }
    const target = await this.path(input.file_path)
    const write = tool === 'Edit' || tool === 'Write'
    if (write && !editable(target.rel, this.directories)) throw new DominoError('CLAUDE_TOOL_DENIED', '拒绝修改源码目录之外的文件或项目配置。')
    if (!write && !editable(target.rel, this.directories) && !METADATA.has(target.rel)) throw new DominoError('CLAUDE_TOOL_DENIED', '拒绝读取源码或项目元数据之外的文件。')
    if (target.stat && !target.stat.isFile()) throw new DominoError('CLAUDE_TOOL_DENIED', '目标不是普通文件。')
    if ((tool === 'Read' || tool === 'Edit') && !target.stat) throw new DominoError('CLAUDE_TOOL_DENIED', '目标文件不存在。')
    return { ...input, file_path: target.path }
  }
}
