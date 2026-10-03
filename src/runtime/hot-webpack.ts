import type { HotBridge } from './hot-types'

declare global {
  interface ImportMeta {
    webpackHot?: {
      data?: Record<string, any>
      accept(): void
      dispose(callback: (data: Record<string, any>) => void): void
      addStatusHandler(callback: (status: string) => void): void
      removeStatusHandler(callback: (status: string) => void): void
    }
  }
}
export function createHot(context: ImportMeta['webpackHot']): HotBridge | undefined {
  return (
    context && {
      data: context.data ?? {},
      dispose: (callback) => context.dispose(callback),
      subscribe(_error, updated) {
        // Compiler errors arrive over the shared Domino transport.
        const onStatus = (status: string) => {
          if (status === 'idle') updated()
        }
        context.addStatusHandler(onStatus)
        return () => context.removeStatusHandler(onStatus)
      },
    }
  )
}
