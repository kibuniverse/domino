import type { EventEmitter } from 'node:events'

import type { DominoOptions } from '../integration/options'

export interface BundlerOptions extends DominoOptions {
  base?: string
}
export interface DominoDevServer {
  compiler: object
  server?: EventEmitter
  options: { server?: unknown }
}
