import type { Compiler } from '@rspack/core'
import type { Compiler as WebpackCompiler } from 'webpack'
import { createBundlerPlugin } from '../webpack/plugin'
import type { BundlerOptions, DominoDevServer } from '../webpack/types'
export type DominoOptions = BundlerOptions
export type { DominoDevServer }

export interface DominoPlugin {
  apply(compiler: Compiler): void
  setupMiddlewares<T>(middlewares: T[], devServer: DominoDevServer): T[]
}
export function domino(options: DominoOptions = {}): DominoPlugin {
  const plugin = createBundlerPlugin(options)
  return {
    // Both engines expose the compiler hooks used by the shared adapter.
    apply(compiler: Compiler) { plugin.apply(compiler as unknown as WebpackCompiler) },
    setupMiddlewares: plugin.setupMiddlewares,
  }
}
