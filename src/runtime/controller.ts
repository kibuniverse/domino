import { capabilities, createStore } from './store'
import { createConnection, uuid } from './connection'
import type { ConnectionMemory } from './connection'
import { createSelection } from './selection'
import type { RuntimeConfig, RuntimeState } from './types'

export interface RuntimeMemory { sessionId: string; state: Partial<RuntimeState>; connection: ConnectionMemory }
export function createController(config: RuntimeConfig, host: HTMLElement, memory?: RuntimeMemory) {
  const previous = memory?.sessionId === config.sessionId ? memory : undefined
  const panelKey = `domino:${config.sessionId}:panel`
  let panelOpen = false
  try { panelOpen = sessionStorage.getItem(panelKey) === 'open' } catch { /* Storage may be unavailable. */ }
  const store = createStore({ panelOpen, ...previous?.state, context: null, highlight: null, picking: false, ready: false, stale: false })
  const connection = createConnection(config, store, previous?.connection)
  const selection = createSelection(config, host, store)
  let stopped = false
  const compileError = (payload: { err: { message: string } }) => store.update({ buildError: `编译诊断：${String(payload.err?.message ?? '未知错误').slice(0, 4000)}` })
  const afterUpdate = () => { store.update({ buildError: '' }); connection.ackPage() }
  import.meta.hot?.on('vite:error', compileError)
  import.meta.hot?.on('vite:afterUpdate', afterUpdate)
  return {
    store,
    start: connection.start,
    togglePanel() { if (store.getSnapshot().panelOpen) selection.closePanel(); else selection.openPanel() },
    closePanel: selection.closePanel,
    togglePicking() { selection.setPicking(!store.getSnapshot().picking) },
    submit() {
      const state = store.getSnapshot()
      if (!capabilities(state).submit) return
      connection.send({ type: 'task.create', requestId: uuid(), context: { ...state.context!, instruction: state.draft.trim(), scope: state.scope } }, true)
      store.update({ draft: '' })
    },
    cancel() { const state = store.getSnapshot(); if (capabilities(state).cancel) connection.send({ type: 'task.cancel', requestId: uuid(), taskId: state.activeId }) },
    undo() { const state = store.getSnapshot(); if (capabilities(state).undo) connection.send({ type: 'task.undo', requestId: uuid(), taskId: state.activeId }) },
    snapshot: (): RuntimeMemory => ({ sessionId: config.sessionId, state: store.getSnapshot(), connection: connection.snapshot() }),
    stop() {
      if (stopped) return
      stopped = true
      try { sessionStorage.setItem(panelKey, store.getSnapshot().panelOpen ? 'open' : 'closed') } catch { /* Storage may be unavailable. */ }
      selection.stop(); connection.stop()
      import.meta.hot?.off('vite:error', compileError)
      import.meta.hot?.off('vite:afterUpdate', afterUpdate)
    },
  }
}
export type RuntimeController = ReturnType<typeof createController>
