import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { editable } from '../core/files'
import { within } from '../core/registry'
import { DominoError } from '../core/types'
import type { SourceRecord } from '../core/types'
import type { RuntimeConfig } from '../runtime/types'
import { SourceCompiler } from './source'

export interface SourceManifest {
  schemaVersion: 1
  projectId: string
  buildId: string
  records: SourceRecord[]
}

export class DeploymentBuild extends SourceCompiler {
  readonly buildId = randomUUID()
  runtimeConfig(): RuntimeConfig {
    return {
      mode: 'deployed',
      projectId: this.options.deployment!.projectId,
      buildId: this.buildId,
      serviceUrl: this.options.deployment!.serviceUrl,
      token: '',
      sessionId: this.buildId,
      wsPath: '/__domino/v1/ws',
      apiPath: '/__domino/v1/',
      shortcuts: this.options.shortcuts,
    }
  }
  async writeManifest(outputDirectory: string) {
    const deployment = this.options.deployment!
    const destination = resolve(
      this.root,
      deployment.manifest ?? `.domino/builds/${deployment.projectId}/latest.json`,
    )
    if (within(resolve(outputDirectory), destination))
      throw new DominoError('INVALID_CONFIG', '源码映射必须保存在公开构建目录之外。')
    const manifest: SourceManifest = {
      schemaVersion: 1,
      projectId: deployment.projectId,
      buildId: this.buildId,
      records: this.registry.list(),
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    const directory = await realpath(dirname(destination))
    const publicDirectory = await realpath(outputDirectory).catch(() => resolve(outputDirectory))
    if (within(publicDirectory, directory))
      throw new DominoError('INVALID_CONFIG', '源码映射目录不能链接到公开构建目录。')
    const contents = JSON.stringify(manifest)
    await writeFile(resolve(dirname(destination), `${this.buildId}.json`), contents, {
      mode: 0o600,
    })
    const temporary = `${destination}.${randomUUID()}.tmp`
    await writeFile(temporary, contents, { mode: 0o600 })
    await rename(temporary, destination)
  }
}

export function parseManifest(
  value: unknown,
  projectId: string,
  directories: string[],
): SourceManifest {
  const manifest = value as SourceManifest
  if (
    !manifest ||
    manifest.schemaVersion !== 1 ||
    manifest.projectId !== projectId ||
    typeof manifest.buildId !== 'string' ||
    !/^[\w-]{8,100}$/.test(manifest.buildId) ||
    !Array.isArray(manifest.records) ||
    manifest.records.length > 100000
  )
    throw new DominoError('INVALID_MANIFEST', '源码映射格式或项目标识无效。')
  const ids = new Set<string>()
  for (const record of manifest.records) {
    if (
      !record ||
      typeof record.file !== 'string' ||
      !editable(record.file, directories) ||
      !/\.[cm]?[jt]sx?$/.test(record.file) ||
      typeof record.sourceId !== 'string' ||
      !/^s_[a-f0-9]{24}$/.test(record.sourceId) ||
      typeof record.fileHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(record.fileHash) ||
      typeof record.tagName !== 'string' ||
      !/^[a-z][\w]*$/.test(record.tagName) ||
      ids.has(record.sourceId) ||
      ![record.start, record.end].every(
        (position) =>
          position &&
          Number.isSafeInteger(position.line) &&
          position.line > 0 &&
          Number.isSafeInteger(position.column) &&
          position.column > 0,
      )
    )
      throw new DominoError('INVALID_MANIFEST', '源码映射包含无效记录。')
    ids.add(record.sourceId)
  }
  return manifest
}

/** Reload latest manifests atomically, retaining previous builds for open pages. */
export class ManifestStore {
  private versions = new Map<string, string>()
  private builds = new Map<string, Set<string>>()
  constructor(
    readonly compiler: SourceCompiler,
    readonly paths: string[],
    readonly projectId: string,
  ) {}
  async reload() {
    for (const path of this.paths) {
      const info = await stat(path)
      if (info.size > 32 * 1024 * 1024)
        throw new DominoError('INVALID_MANIFEST', '源码映射超过大小限制。')
      const version = `${info.mtimeMs}:${info.size}:${info.ino}`
      if (this.versions.get(path) === version) continue
      const manifest = parseManifest(
        JSON.parse(await readFile(path, 'utf8')),
        this.projectId,
        this.compiler.options.directories,
      )
      const existing = this.builds.get(manifest.buildId)
      const ids = new Set(manifest.records.map((record) => record.sourceId))
      if (existing && (existing.size !== ids.size || [...ids].some((id) => !existing.has(id))))
        throw new DominoError('INVALID_MANIFEST', '同一构建标识不能对应不同源码映射。')
      this.compiler.registry.merge(manifest.records)
      this.builds.set(manifest.buildId, ids)
      this.versions.set(path, version)
    }
  }
  has(buildId: string, sourceId?: string) {
    const records = this.builds.get(buildId)
    return !!records && (sourceId === undefined || records.has(sourceId))
  }
}
