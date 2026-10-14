import { readFile, realpath } from 'node:fs/promises'
import { relative } from 'node:path'

import { editable } from '../core/files'
import { SourceRegistry, within } from '../core/registry'
import { instrument, hash } from '../transform/index'
import type { NormalizedOptions } from './options'

/** Source instrumentation has no Agent, transport or workspace lock. */
export class SourceCompiler {
  readonly registry: SourceRegistry
  constructor(
    public root: string,
    public base: string,
    readonly options: NormalizedOptions,
  ) {
    this.registry = new SourceRegistry(root)
  }
  remove(path: string) {
    this.registry.remove(relative(this.root, path).split('\\').join('/'))
  }
  isSourcePath(path: string) {
    if (path.startsWith('\0') || !within(this.root, path) || !/\.[cm]?[jt]sx?$/.test(path))
      return false
    return editable(relative(this.root, path).split('\\').join('/'), this.options.directories)
  }
  async transform(
    code: string,
    path: string,
    runtimeImport: string,
    warn: (message: string) => void,
    format: 'esm' | 'commonjs' = 'esm',
  ) {
    if (!this.isSourcePath(path)) return
    const file = relative(this.root, path).split('\\').join('/')
    const skip = () => this.registry.remove(file)
    try {
      if ((await realpath(path)) !== path) {
        skip()
        return
      }
      if (hash(await readFile(path, 'utf8')) !== hash(code)) {
        skip()
        warn(`domino: skipped ${file}; place domino before source-transforming plugins/loaders.`)
        return
      }
      let reporter = `__domino_${hash(code).slice(0, 16)}`
      while (code.includes(reporter)) reporter += '_'
      const dependency = JSON.stringify(runtimeImport)
      const binding =
        format === 'commonjs'
          ? `const { reportVersion: ${reporter} } = require(${dependency});`
          : `import { reportVersion as ${reporter} } from ${dependency};`
      const result = instrument(
        code,
        file,
        `\n${binding}\n${reporter}(${JSON.stringify(file)}, ${JSON.stringify(hash(code))});\n`,
      )
      this.registry.replace(file, result.records)
      return result
    } catch (error) {
      skip()
      throw error
    }
  }
}
