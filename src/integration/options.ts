import type { AgentConfig } from '../agents/index'
import { DEFAULT_DIRS, validateDirectories } from '../core/files'
import { DominoError } from '../core/types'

export interface DominoOptions {
  agent?: AgentConfig
  shortcut?: string | string[]
  directories?: string[]
  execution?: { timeoutMs?: number; queueLimit?: number }
  allowLan?: boolean
}

export function normalizeOptions(options: DominoOptions) {
  const timeoutMs = options.execution?.timeoutMs ?? 300000
  const queueLimit = options.execution?.queueLimit ?? 3
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 1800000 ||
    !Number.isInteger(queueLimit) ||
    queueLimit < 1 ||
    queueLimit > 10
  )
    throw new DominoError('INVALID_CONFIG', '任务超时或队列配置无效。')
  const shortcutList = Array.isArray(options.shortcut)
    ? options.shortcut
    : options.shortcut
      ? [options.shortcut]
      : ['Alt+Space', 'Space']
  return {
    agent: options.agent,
    directories: validateDirectories(options.directories ?? DEFAULT_DIRS),
    timeoutMs,
    queueLimit,
    allowLan: options.allowLan ?? false,
    shortcuts: [...new Set(shortcutList.map((shortcut) => shortcut.trim()).filter(Boolean))],
  }
}
export type NormalizedOptions = ReturnType<typeof normalizeOptions>
export function validateBase(base: string) {
  if (!base.startsWith('/') || !base.endsWith('/') || /[?#\\]/.test(base) || base.startsWith('//'))
    throw new DominoError('INVALID_BASE', 'Domino base 必须是以 / 开始和结束的路径。')
  return base
}
