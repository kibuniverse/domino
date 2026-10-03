import type { Compiler } from 'webpack'
import { createBundlerPlugin } from './plugin'
import type { BundlerOptions, DominoDevServer } from './types'
export type DominoOptions = BundlerOptions
export type { DominoDevServer }

export interface DominoPlugin {
  apply(compiler: Compiler): void
  setupMiddlewares<T>(middlewares: T[], devServer: DominoDevServer): T[]
}
export function domino(options: DominoOptions = {}): DominoPlugin {
  const plugin = createBundlerPlugin(options)
  return {
    apply(compiler: Compiler) { plugin.apply(compiler) },
    setupMiddlewares: plugin.setupMiddlewares,
  }
}
