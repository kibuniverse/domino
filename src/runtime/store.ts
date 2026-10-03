import { TERMINAL } from '../core/types'
import type { RuntimeState } from './types'

export function createStore(initial: Partial<RuntimeState> = {}) {
  let state: RuntimeState = {
    panelOpen: false,
    progressOpen: false,
    focusRequest: 0,
    draft: '',
    scope: 'auto',
    context: null,
    stale: false,
    picking: false,
    highlight: null,
    ready: false,
    pendingCreate: false,
    diagnostic: { ready: false, message: '连接中' },
    connectionMessage: '正在连接开发服务器…',
    tasks: [],
    notice: '',
    buildError: '',
    ...initial,
  }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    update(patch: Partial<RuntimeState>) {
      if (
        Object.entries(patch).every(([key, value]) =>
          Object.is(state[key as keyof RuntimeState], value),
        )
      )
        return
      state = { ...state, ...patch }
      for (const listener of listeners) listener()
    },
  }
}
export type RuntimeStore = ReturnType<typeof createStore>
export function capabilities(state: RuntimeState) {
  const task = state.tasks.find((task) => task.id === state.activeId)
  return {
    submit:
      state.ready &&
      state.diagnostic.ready &&
      !!state.context?.sourceId &&
      !state.stale &&
      !!state.draft.trim() &&
      !state.pendingCreate,
    cancel: !!task && state.ready && !TERMINAL.has(task.status) && task.status !== 'cancelling',
    undo:
      !!task &&
      state.ready &&
      task.applied &&
      !task.undone &&
      !state.tasks.some((task) => !TERMINAL.has(task.status)),
  }
}
