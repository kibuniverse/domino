import type { Task, Diagnostic, VisualContext } from '../core/types'
import type { RuntimeStore } from './store'
import type { RuntimeConfig } from './types'
import { reportedVersions, subscribeVersions } from './versions'

type Request = { type: string; requestId?: string; context?: VisualContext; [key: string]: unknown }
type Message =
  | { type: 'ready'; diagnostic: Diagnostic; tasks: Task[]; buildError?: string }
  | { type: 'build.status'; error: string }
  | { type: 'task.snapshot'; task: Task }
  | { type: 'reply'; requestId?: string; taskId?: string; error?: string }
export interface ConnectionMemory {
  pending: Request[]
}

// crypto.randomUUID requires a secure context; LAN HTTP needs the fallback.
export function uuid() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function createConnection(
  config: RuntimeConfig,
  store: RuntimeStore,
  memory?: ConnectionMemory,
) {
  let stopped = false
  let socket: WebSocket | undefined
  let reconnect: ReturnType<typeof setTimeout> | undefined
  let reconnectDelay = 500
  const pending = new Map<string, Request>()
  for (const request of memory?.pending ?? [])
    if (request.requestId) pending.set(request.requestId, request)
  const syncPending = () =>
    store.update({
      pendingCreate: [...pending.values()].some((request) => request.type === 'task.create'),
    })
  syncPending()
  const send = (request: Request, retry = false) => {
    if (stopped) return
    if (retry && request.requestId) pending.set(request.requestId, request)
    if (store.getSnapshot().ready && socket?.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(request))
    else if (!retry) store.update({ notice: '连接已断开，请等待重新连接。' })
    syncPending()
  }
  const ackPage = () => {
    const state = store.getSnapshot()
    if (!state.ready || stopped) return
    for (const task of state.tasks)
      if (task.status === 'completed' && task.pageUpdate === 'pending' && !task.undone) {
        const paths = task.changes
          .filter((change) => /\.[cm]?[jt]sx?$/.test(change.path))
          .map((change) => change.path)
        const versions = reportedVersions(paths)
        if (paths.length && paths.every((path) => versions[path]))
          send({ type: 'task.pageUpdated', taskId: task.id, versions })
      }
  }
  const mergeTasks = (incoming: Task[], replace = false) => {
    const state = store.getSnapshot()
    const tasks = new Map(replace ? [] : state.tasks.map((task) => [task.id, task] as const))
    for (const task of incoming) {
      const previous = state.tasks.find((existing) => existing.id === task.id)
      tasks.set(task.id, previous && previous.seq > task.seq ? previous : task)
    }
    const sorted = [...tasks.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 20)
    store.update({
      tasks: sorted,
      activeId: sorted.some((task) => task.id === state.activeId) ? state.activeId : sorted[0]?.id,
    })
  }
  const connect = () => {
    if (stopped) return
    const current = new WebSocket(
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${config.wsPath}`,
    )
    socket = current
    current.onopen = () =>
      current.send(
        JSON.stringify({
          type: 'hello',
          protocolVersion: 1,
          token: config.token,
          sessionId: config.sessionId,
        }),
      )
    current.onmessage = (event) => {
      if (stopped || current !== socket) return
      let message: Message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (!message || typeof message !== 'object') return
      if (message.type === 'ready') {
        reconnectDelay = 500
        store.update({
          ready: true,
          diagnostic: message.diagnostic,
          connectionMessage: message.diagnostic.message,
          buildError: message.buildError ? `编译诊断：${message.buildError.slice(0, 4000)}` : '',
        })
        mergeTasks(message.tasks, true)
        for (const request of pending.values()) send(request)
        ackPage()
      } else if (message.type === 'build.status') {
        store.update({
          buildError: message.error ? `编译诊断：${message.error.slice(0, 4000)}` : '',
        })
      } else if (message.type === 'task.snapshot') {
        mergeTasks([message.task])
        ackPage()
      } else if (message.type === 'reply') {
        const request = message.requestId ? pending.get(message.requestId) : undefined
        if (message.requestId) pending.delete(message.requestId)
        if (message.error) {
          const state = store.getSnapshot()
          store.update({
            notice: message.error,
            ...(request?.context && !state.draft.trim()
              ? { draft: request.context.instruction }
              : {}),
          })
        } else if (message.taskId)
          store.update({ activeId: message.taskId, progressOpen: false, notice: '任务已提交。' })
        syncPending()
      }
    }
    current.onclose = (event) => {
      if (stopped || current !== socket) return
      store.update({
        ready: false,
        connectionMessage:
          event.code === 1008
            ? '连接被拒绝，请刷新页面并检查本地访问地址。'
            : '连接断开，正在重连…',
      })
      if (event.code !== 1008) {
        reconnect = setTimeout(connect, reconnectDelay)
        reconnectDelay = Math.min(10000, reconnectDelay * 2)
      }
    }
    current.onerror = () => {}
  }
  const unsubscribe = subscribeVersions(ackPage)
  return {
    start: connect,
    send,
    ackPage,
    snapshot: (): ConnectionMemory => ({ pending: [...pending.values()] }),
    stop() {
      stopped = true
      clearTimeout(reconnect)
      unsubscribe()
      socket?.close()
      store.update({ ready: false })
    },
  }
}
