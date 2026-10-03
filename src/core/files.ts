import { randomUUID } from 'node:crypto'
import {
  lstat,
  readdir,
  readFile,
  writeFile,
  mkdir,
  realpath,
  rename,
  unlink,
  chmod,
} from 'node:fs/promises'
import { dirname, extname, join, resolve, relative } from 'node:path'

import { createTwoFilesPatch } from 'diff'

import { hash, validateSyntax } from '../transform/index'
import { within } from './registry'
import { DominoError } from './types'
import type { FileChange } from './types'

export interface SavedFile {
  content: string
  mode: number
}
export type Snapshot = Record<string, SavedFile>
export const DEFAULT_DIRS = ['src', 'public']
const EDIT_EXTENSIONS = new Set([
  '.tsx',
  '.jsx',
  '.ts',
  '.js',
  '.mts',
  '.cts',
  '.mjs',
  '.cjs',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.json',
  '.svg',
  '.html',
])
const METADATA = ['package.json', 'tsconfig.json', 'AGENTS.md', 'README.md', 'index.html']
const MAX_FILE = 1024 * 1024
const MAX_TOTAL = 10 * 1024 * 1024

export function editable(path: string, dirs: string[]): boolean {
  const parts = path.split('/')
  return (
    dirs.some((dir) => path.startsWith(`${dir}/`)) &&
    EDIT_EXTENSIONS.has(extname(path)) &&
    !parts.some(
      (part) =>
        part.startsWith('.') ||
        /^(node_modules|dist|credentials?|secrets?)$/i.test(part) ||
        /\.(pem|key)$/i.test(part),
    )
  )
}

export function validateDirectories(dirs: string[]) {
  if (
    !dirs.length ||
    dirs.some(
      (dir) =>
        !/^[\w-]+(?:\/[\w-]+)*$/.test(dir) ||
        /(^|\/)(node_modules|dist|build|coverage)(\/|$)/.test(dir),
    )
  )
    throw new DominoError('INVALID_CONFIG', '可编辑目录必须是工作区内的源码目录。')
  return [...new Set(dirs)]
}

async function missing(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function capture(root: string, dirs: string[], candidate = false): Promise<Snapshot> {
  const result: Snapshot = Object.create(null)
  let total = 0
  const add = async (path: string) => {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.size > MAX_FILE)
      throw new DominoError('SNAPSHOT_LIMIT', `无法完整保存 ${relative(root, path)}，任务未应用。`)
    const data = await readFile(path)
    const content = data.toString('utf8')
    if (content.includes('\0') || !Buffer.from(content).equals(data)) {
      if (candidate) throw new DominoError('UNSUPPORTED_FILE', '候选目录中含有不支持的二进制文件。')
      return
    }
    total += data.length
    if (total > MAX_TOTAL || Object.keys(result).length >= 1000)
      throw new DominoError('SNAPSHOT_LIMIT', '源码快照超过 10 MiB 或 1000 个文件。')
    result[relative(root, path).split('\\').join('/')] = { content, mode: stat.mode & 0o777 }
  }
  const walk = async (path: string) => {
    const stat = await missing(path)
    if (!stat) return
    if (stat.isSymbolicLink())
      throw new DominoError('SYMLINK', `不支持源码符号链接：${relative(root, path)}`)
    if (stat.isDirectory()) {
      for (const entry of await readdir(path)) {
        const rel = relative(root, join(path, entry)).split('\\').join('/')
        if (!candidate && (entry.startsWith('.') || entry === 'node_modules' || entry === 'dist'))
          continue
        if (candidate || editable(rel, dirs)) await walk(join(path, entry))
        else if ((await lstat(join(path, entry))).isDirectory()) await walk(join(path, entry))
      }
    } else if (candidate || editable(relative(root, path).split('\\').join('/'), dirs))
      await add(path)
  }
  if (candidate) await walk(root)
  else {
    for (const dir of dirs) await walk(resolve(root, dir))
    for (const file of METADATA) {
      const path = join(root, file)
      const stat = await missing(path)
      if (stat?.isSymbolicLink()) throw new DominoError('SYMLINK', `不支持元数据符号链接：${file}`)
      if (stat?.isFile()) await add(path)
    }
  }
  return result
}

export async function materialize(root: string, snapshot: Snapshot) {
  for (const [path, file] of Object.entries(snapshot)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), file.content, { mode: file.mode })
  }
}

export function changesBetween(before: Snapshot, after: Snapshot): FileChange[] {
  const changes: FileChange[] = []
  for (const path of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const oldContent = before[path]?.content ?? null
    const newContent = after[path]?.content ?? null
    if (oldContent === newContent && before[path]?.mode === after[path]?.mode) continue
    changes.push({
      path,
      before: oldContent,
      after: newContent,
      beforeHash: oldContent == null ? null : hash(oldContent),
      afterHash: newContent == null ? null : hash(newContent),
      patch: createTwoFilesPatch(
        oldContent == null ? '/dev/null' : `a/${path}`,
        newContent == null ? '/dev/null' : `b/${path}`,
        oldContent ?? '',
        newContent ?? '',
      ),
    })
  }
  return changes
}

export function validateChanges(changes: FileChange[], dirs: string[]) {
  if (changes.length > 30) throw new DominoError('CHANGE_LIMIT', '单次任务最多修改 30 个文件。')
  if (changes.reduce((n, file) => n + file.patch.length, 0) > 1024 * 1024)
    throw new DominoError('DIFF_LIMIT', '候选 diff 超过 1 MiB。')
  for (const change of changes) {
    if (!editable(change.path, dirs))
      throw new DominoError('OUTSIDE_WRITE_SCOPE', `不允许修改 ${change.path}。`)
    if (change.after != null) validateSyntax(change.after, change.path)
  }
}

async function safePath(root: string, path: string): Promise<string> {
  const destination = resolve(root, path)
  if (!within(root, destination) || destination === root)
    throw new DominoError('PATH_TRAVERSAL', '文件路径超出工作区。')
  let parent = dirname(destination)
  let component = root
  for (const part of relative(root, dirname(destination)).split('/').filter(Boolean)) {
    component = join(component, part)
    if ((await missing(component))?.isSymbolicLink())
      throw new DominoError('SYMLINK', '拒绝通过目录符号链接修改文件。')
  }
  while (!(await missing(parent))) parent = dirname(parent)
  if (!within(root, await realpath(parent)))
    throw new DominoError('SYMLINK', '父目录链接超出工作区。')
  const stat = await missing(destination)
  if (stat?.isSymbolicLink() || (stat && !stat.isFile()))
    throw new DominoError('SYMLINK', '拒绝修改符号链接或特殊文件。')
  return destination
}

export async function assertCurrent(
  root: string,
  changes: FileChange[],
  direction: 'apply' | 'undo',
) {
  for (const change of changes) {
    const path = await safePath(root, change.path)
    const stat = await missing(path)
    const current = stat ? hash(await readFile(path, 'utf8')) : null
    const expected = direction === 'apply' ? change.beforeHash : change.afterHash
    if (current !== expected)
      throw new DominoError('FILE_CONFLICT', `${change.path} 已被其他操作修改，整项操作已停止。`)
  }
}

// Each replacement is atomic; the operation across multiple files is not a filesystem transaction.
export async function restoreChanges(
  root: string,
  changes: FileChange[],
  before: Snapshot,
  after: Snapshot,
  direction: 'apply' | 'undo',
  onFile: (path: string) => Promise<void>,
) {
  await assertCurrent(root, changes, direction)
  for (const change of changes) {
    await assertCurrent(root, [change], direction)
    const path = await safePath(root, change.path)
    const target = (direction === 'apply' ? after : before)[change.path]
    if (!target) await unlink(path)
    else {
      await mkdir(dirname(path), { recursive: true })
      const exists = await missing(path)
      if (!exists) await writeFile(path, target.content, { flag: 'wx', mode: target.mode })
      else {
        const temp = `${path}.domino-${randomUUID()}`
        try {
          await writeFile(temp, target.content, { flag: 'wx', mode: target.mode })
          await rename(temp, path)
        } finally {
          if (await missing(temp)) await unlink(temp)
        }
        await chmod(path, target.mode)
      }
    }
    await onFile(change.path)
  }
}
