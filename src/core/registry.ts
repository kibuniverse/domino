import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { DominoError } from './types'
import type { SourceRecord } from './types'
import { hash } from '../transform/index'

export function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

export class SourceRegistry {
  private records = new Map<string, SourceRecord>()
  private files = new Map<string, string[]>()
  constructor(public root: string) {}
  replace(file: string, records: SourceRecord[]) {
    this.remove(file)
    this.files.set(file, records.map(record => record.sourceId))
    for (const record of records) {
      const existing = this.records.get(record.sourceId)
      if (existing && existing.file !== file) throw new DominoError('SOURCE_COLLISION', 'Source identifier collision')
      this.records.set(record.sourceId, record)
    }
  }
  remove(file: string) {
    for (const id of this.files.get(file) ?? []) this.records.delete(id)
    this.files.delete(file)
  }
  async resolve(sourceId: string): Promise<{ source: SourceRecord; code: string }> {
    const source = this.records.get(sourceId)
    if (!source) throw new DominoError('STALE_SELECTION', '源码定位已失效，请重新选择元素。')
    const path = await realpath(resolve(this.root, source.file))
    if (!within(this.root, path)) throw new DominoError('OUTSIDE_WORKSPACE', '源码路径超出工作区。')
    const code = await readFile(path, 'utf8')
    if (hash(code) !== source.fileHash) throw new DominoError('STALE_SELECTION', '源码已变化，请重新选择元素。')
    return { source, code }
  }
}
