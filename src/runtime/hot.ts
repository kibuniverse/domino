import type { HotBridge } from './hot-types'

export function createHot(context: ImportMeta['hot']): HotBridge | undefined {
  return (
    context && {
      data: context.data,
      dispose: (callback) => context.dispose(callback),
      subscribe(error, updated) {
        const onError = (payload: { err: { message: string } }) =>
          error(String(payload.err?.message ?? '未知错误'))
        context.on('vite:error', onError)
        context.on('vite:afterUpdate', updated)
        return () => {
          context.off('vite:error', onError)
          context.off('vite:afterUpdate', updated)
        }
      },
    }
  )
}
