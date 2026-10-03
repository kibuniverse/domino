import type { DominoSession } from '../integration/session'

// Shared identity across separately bundled ESM plugins and the CJS loaders.
export const SESSION = Symbol.for('@kibuniverse/domino/compiler-session/v1')
export interface CompilerSession {
  active: boolean
  session: DominoSession
  runtimeEntry: string
}
export function getSession(compiler: object): CompilerSession | undefined {
  return (compiler as Record<symbol, CompilerSession>)[SESSION]
}
