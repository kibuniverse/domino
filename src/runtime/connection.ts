import { TERMINAL } from '../core/types'
import type { Task, Diagnostic, VisualContext } from '../core/types'
import type { RuntimeStore } from './store'
import type { RuntimeConfig } from './types'
import { reportedVersions, subscribeVersions } from './versions'

type Request = { type: string; requestId?: string; context?: VisualContext; [key: string]: unknown }
type Message =
  | {
      type: 'ready'
      diagnostic: Diagnostic
      tasks: Task[]
      buildError?: string
      sessionId?: string
      projectId?: string
      taskIds?: string[]
    }
  | { type: 'build.status'; error: string }
  | { type: 'task.snapshot'; task: Task }
  | { type: 'reply'; requestId?: string; taskId?: string; error?: string }
  | { type: 'pong' }
  | { type: 'error'; error: string }
export interface ConnectionMemory {
  pending: Request[]
  endpoint?: string
  sessionId?: string
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
export function normalizeServiceUrl(value: string) {
  const origin = `${location.protocol}//${location.host}`
  let url: URL
  try {
    url = new URL(value.trim() || origin)
  } catch {
    throw new Error('请输入完整的 HTTP/HTTPS 服务地址。')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('请输入完整的 HTTP/HTTPS 服务地址。')
  if (location.protocol === 'https:' && url.protocol !== 'https:')
    throw new Error('HTTPS 页面请使用 HTTPS 编辑服务地址。')
  return url.href.replace(/\/$/, '')
}
export function createConnection(
  config: RuntimeConfig,
  store: RuntimeStore,
  memory?: ConnectionMemory,
) {
  let stopped = false
  let blocked = false
  let generation = 0
  let socket: WebSocket | undefined
  let reconnect: ReturnType<typeof setTimeout> | undefined
  let handshake: ReturnType<typeof setTimeout> | undefined
  let poll: ReturnType<typeof setTimeout> | undefined
  let probe: ReturnType<typeof setTimeout> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let retryRequests: ReturnType<typeof setInterval> | undefined
  let reconnectDelay = 500
  let failures = 0
  let lastMessage = Date.now()
  let pollingGeneration: number | undefined
  let transport: 'ws' | 'http' | 'offline' = 'offline'
  let endpoint = config.serviceUrl ?? ''
  let token = config.token
  let sessionId: string | undefined = config.mode === 'deployed' ? undefined : config.sessionId
  const controllers = new Set<AbortController>()
  const pending = new Map<string, Request>()
  const inFlight = new Set<string>()
  const acknowledged = new Set<string>()
  const storageKey = `domino:${config.projectId ?? config.sessionId}:service`
  try {
    endpoint = localStorage.getItem(storageKey) ?? endpoint
    if (endpoint) endpoint = normalizeServiceUrl(endpoint)
    if (config.mode === 'deployed' && endpoint) {
      const saved = JSON.parse(
        sessionStorage.getItem(`${storageKey}:${endpoint}:credential`) ?? 'null',
      )
      if (saved?.expiresAt > Date.now()) {
        token = saved.token
        sessionId = saved.sessionId
      }
    }
  } catch {
    /* Browser storage and stale settings are optional. */
  }
  if (memory?.endpoint === endpoint || (!memory?.endpoint && !endpoint)) {
    for (const request of memory?.pending ?? [])
      if (request.requestId) pending.set(request.requestId, request)
    sessionId = memory?.sessionId ?? sessionId
  }
  store.update({ serviceUrl: endpoint, deployed: config.mode === 'deployed' })
  const syncPending = () =>
    store.update({
      pendingCreate: [...pending.values()].some((request) => request.type === 'task.create'),
    })
  syncPending()
  const hello = () => ({
    type: 'hello',
    protocolVersion: 1,
    token,
    sessionId,
    ...(config.projectId ? { projectId: config.projectId, buildId: config.buildId } : {}),
  })
  const base = () => `${endpoint || `${location.protocol}//${location.host}`}/`
  const api = (route: string) =>
    new URL(
      `${(config.apiPath ?? config.wsPath.replace(/ws$/, 'v1/')).replace(/^\//, '')}${route}`,
      base(),
    ).href
  const restoreDraft = () => {
    const context = [...pending.values()].find((request) => request.type === 'task.create')?.context
    if (context && !store.getSnapshot().draft.trim()) store.update({ draft: context.instruction })
  }
  const clearTimers = () => {
    clearTimeout(reconnect)
    clearTimeout(handshake)
    clearTimeout(poll)
    clearTimeout(probe)
    clearInterval(heartbeat)
    clearInterval(retryRequests)
  }
  const disconnect = () => {
    generation++
    clearTimers()
    const old = socket
    socket = undefined
    old?.close()
    for (const controller of controllers) controller.abort()
    controllers.clear()
    inFlight.clear()
    acknowledged.clear()
    transport = 'offline'
    store.update({ ready: false, transport: 'offline' })
  }
  const fatal = (message: string) => {
    blocked = true
    restoreDraft()
    disconnect()
    store.update({ connectionMessage: message, notice: message, settingsOpen: true })
  }
  const post = async (route: string, body: unknown) => {
    const controller = new AbortController()
    controllers.add(controller)
    const timeout = setTimeout(() => controller.abort(), 5000)
    try {
      const response = await fetch(api(route), {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const result = await response.json()
      if (!response.ok) {
        const error = new Error(result.error ?? `服务返回 ${response.status}`) as Error & {
          fatal?: boolean
        }
        error.fatal = [401, 403, 409].includes(response.status)
        throw error
      }
      return result
    } finally {
      clearTimeout(timeout)
      controllers.delete(controller)
    }
  }
  const mergeTasks = (incoming: Task[], ids?: string[], replace = false) => {
    const state = store.getSnapshot()
    const tasks = new Map(
      replace
        ? []
        : state.tasks
            .filter((task) => !ids || ids.includes(task.id))
            .map((task) => [task.id, task] as const),
    )
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
  const receive = (message: Message) => {
    if (message.type === 'ready') {
      if (sessionId && message.sessionId && message.sessionId !== sessionId) {
        fatal('编辑服务已重启，请刷新页面并核对已有任务。')
        return
      }
      sessionId = message.sessionId ?? sessionId
      reconnectDelay = 500
      failures = 0
      store.update({
        ready: true,
        diagnostic: message.diagnostic,
        projectName: message.projectId ?? '',
        connectionMessage: `${message.diagnostic.message}${transport === 'http' ? ' · HTTP 轮询' : ''}`,
        buildError: message.buildError ? `编译诊断：${message.buildError.slice(0, 4000)}` : '',
      })
      mergeTasks(message.tasks, message.taskIds, !message.taskIds)
      for (const task of message.tasks)
        if (pending.get(task.requestId)?.type === 'task.create')
          receive({ type: 'reply', requestId: task.requestId, taskId: task.id })
      for (const request of pending.values()) send(request)
      ackPage()
    } else if (message.type === 'build.status') {
      store.update({ buildError: message.error ? `编译诊断：${message.error.slice(0, 4000)}` : '' })
    } else if (message.type === 'task.snapshot') {
      mergeTasks([message.task])
      if (pending.get(message.task.requestId)?.type === 'task.create')
        receive({ type: 'reply', requestId: message.task.requestId, taskId: message.task.id })
      ackPage()
    } else if (message.type === 'reply') {
      const request = message.requestId ? pending.get(message.requestId) : undefined
      if (message.requestId) pending.delete(message.requestId)
      if (message.error) {
        const state = store.getSnapshot()
        store.update({
          notice: message.error,
          ...(message.error.startsWith('STALE_SELECTION') ? { stale: true } : {}),
          ...(request?.context && !state.draft.trim()
            ? { draft: request.context.instruction }
            : {}),
        })
      } else if (message.taskId && request)
        store.update({ activeId: message.taskId, progressOpen: false, notice: '任务已提交。' })
      syncPending()
    } else if (message.type === 'error') fatal(message.error)
  }
  const send = (request: Request, retry = false) => {
    if (stopped || blocked) return
    if (request.requestId && (retry || ['task.cancel', 'task.undo'].includes(request.type)))
      pending.set(request.requestId, request)
    syncPending()
    if (!store.getSnapshot().ready) {
      if (!retry) store.update({ notice: '连接已断开，请等待重新连接。' })
      return
    }
    if (transport === 'ws' && socket?.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify(request))
      } catch {
        fallback()
      }
    } else if (transport === 'http') {
      if (request.requestId && inFlight.has(request.requestId)) return
      const current = generation
      if (request.requestId) inFlight.add(request.requestId)
      void post('command', { hello: hello(), request })
        .then((message) => {
          if (current === generation && !stopped) {
            receive(message)
            if (transport === 'http' && !blocked) {
              clearTimeout(poll)
              void pollOnce()
            }
          }
        })
        .catch((error) => {
          if (current !== generation || stopped) return
          acknowledged.clear()
          if (error.fatal) fatal(error.message)
          else store.update({ notice: '操作回复未收到，正在同步确认。' })
        })
        .finally(() => {
          if (current === generation && request.requestId) inFlight.delete(request.requestId)
        })
    }
  }
  const ackPage = () => {
    const state = store.getSnapshot()
    if (!state.ready || stopped || blocked) return
    for (const task of state.tasks)
      if (task.status === 'completed' && task.pageUpdate === 'pending' && !task.undone) {
        const paths = task.changes
          .filter((change) => /\.[cm]?[jt]sx?$/.test(change.path))
          .map((change) => change.path)
        const versions = reportedVersions(paths)
        const key = `${task.id}:${JSON.stringify(versions)}`
        if (paths.length && paths.every((path) => versions[path]) && !acknowledged.has(key)) {
          acknowledged.add(key)
          send({ type: 'task.pageUpdated', taskId: task.id, versions })
        }
      }
  }
  const pollOnce = async () => {
    if (stopped || blocked || transport !== 'http' || pollingGeneration === generation) return
    const current = generation
    pollingGeneration = current
    try {
      const seqs = Object.fromEntries(store.getSnapshot().tasks.map((task) => [task.id, task.seq]))
      const message = await post('sync', { hello: hello(), seqs })
      if (current !== generation || stopped || transport !== 'http') return
      receive(message)
    } catch (error: any) {
      if (current !== generation || stopped || transport !== 'http') return
      if (error.fatal) {
        fatal(error.message)
        return
      }
      store.update({
        ready: false,
        connectionMessage: '编辑服务不可达，请检查地址、网络、证书或跨域配置。',
        settingsOpen: true,
      })
    } finally {
      if (pollingGeneration === current) pollingGeneration = undefined
    }
    if (current === generation && !stopped && !blocked && transport === 'http') {
      const state = store.getSnapshot()
      poll = setTimeout(
        () => void pollOnce(),
        state.ready && state.tasks.some((task) => !TERMINAL.has(task.status)) ? 1000 : 5000,
      )
    }
  }
  const scheduleProbe = () => {
    clearTimeout(probe)
    probe = setTimeout(() => {
      if (!stopped && !blocked && transport === 'http') connect()
    }, 30000)
  }
  const fallback = () => {
    if (stopped || blocked) return
    clearTimeout(reconnect)
    clearTimeout(handshake)
    clearInterval(heartbeat)
    const old = socket
    socket = undefined
    old?.close()
    acknowledged.clear()
    if (transport !== 'http') {
      transport = 'http'
      store.update({ ready: false, transport, connectionMessage: '正在使用 HTTP 连接编辑服务…' })
      void pollOnce()
    }
    scheduleProbe()
  }
  const connect = () => {
    if (stopped || blocked) return
    clearTimeout(reconnect)
    let current: WebSocket
    try {
      const url = new URL(config.wsPath.replace(/^\//, ''), base())
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      current = new WebSocket(url.href)
    } catch {
      fallback()
      return
    }
    socket = current
    const currentGeneration = generation
    handshake = setTimeout(() => {
      if (socket === current) fallback()
    }, 5000)
    current.onopen = () => {
      if (socket === current && !stopped && currentGeneration === generation)
        current.send(JSON.stringify(hello()))
    }
    current.onmessage = (event) => {
      if (stopped || socket !== current || currentGeneration !== generation) return
      let message: Message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (!message || typeof message !== 'object') return
      lastMessage = Date.now()
      if (message.type === 'ready') {
        clearTimeout(handshake)
        clearTimeout(poll)
        clearTimeout(probe)
        clearInterval(heartbeat)
        transport = 'ws'
        store.update({ transport })
        heartbeat = setInterval(() => {
          if (Date.now() - lastMessage >= 45000) {
            fallback()
            return
          }
          if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type: 'ping' }))
        }, 15000)
      }
      receive(message)
    }
    current.onclose = (event) => {
      if (stopped || socket !== current || currentGeneration !== generation || blocked) return
      socket = undefined
      clearTimeout(handshake)
      clearInterval(heartbeat)
      if (event.code === 1008) {
        fatal('连接被拒绝，请检查配对信息或刷新页面。')
        return
      }
      if (transport === 'http' || ++failures >= 2) {
        fallback()
        return
      }
      transport = 'offline'
      store.update({ ready: false, transport, connectionMessage: '连接断开，正在重连…' })
      reconnect = setTimeout(connect, reconnectDelay)
      reconnectDelay = Math.min(10000, reconnectDelay * 2)
    }
    current.onerror = () => {}
  }
  const start = () => {
    clearInterval(retryRequests)
    retryRequests = setInterval(() => {
      if (store.getSnapshot().ready) for (const request of pending.values()) send(request)
    }, 5000)
    if (config.mode === 'deployed' && (!endpoint || !token)) {
      store.update({
        ready: false,
        settingsOpen: true,
        connectionMessage: '请启动 Node 编辑服务并设置服务地址。',
      })
      return
    }
    if (config.mode === 'deployed') {
      // Validate project/build over HTTP before opening the optional realtime channel.
      fallback()
      connect()
    } else connect()
  }
  const configure = async (value: string, code: string) => {
    let next: string
    try {
      next = normalizeServiceUrl(value)
    } catch (error: any) {
      store.update({ notice: error.message })
      return
    }
    if (!config.projectId || !config.buildId) {
      store.update({ notice: '独立编辑服务需要开启 deployment 配置并重新构建页面。' })
      return
    }
    restoreDraft()
    disconnect()
    blocked = false
    pending.clear()
    syncPending()
    endpoint = next
    token = ''
    sessionId = undefined
    store.update({
      serviceUrl: endpoint,
      tasks: [],
      activeId: undefined,
      context: null,
      stale: false,
      notice: '',
      connectionMessage: '正在配对编辑服务…',
    })
    const current = generation
    try {
      const credential = await post('pair', { code: code.trim(), projectId: config.projectId })
      if (current !== generation || stopped) return
      token = credential.token
      sessionId = credential.sessionId
      await post('session', { hello: hello() })
      if (current !== generation || stopped) return
      try {
        localStorage.setItem(storageKey, endpoint)
        sessionStorage.setItem(`${storageKey}:${endpoint}:credential`, JSON.stringify(credential))
      } catch {
        /* Optional browser storage. */
      }
      store.update({ settingsOpen: false, notice: '编辑服务已连接。' })
      start()
    } catch (error: any) {
      if (current === generation && !stopped)
        fatal(error.message ?? '连接失败，请检查地址、网络、证书或跨域配置。')
    }
  }
  const unsubscribe = subscribeVersions(ackPage)
  return {
    start,
    send,
    ackPage,
    configure,
    async testService(value: string) {
      const current = generation
      const controller = new AbortController()
      controllers.add(controller)
      const timeout = setTimeout(() => controller.abort(), 5000)
      try {
        const url = new URL('__domino/v1/health', `${normalizeServiceUrl(value)}/`)
        const response = await fetch(url, {
          mode: 'cors',
          credentials: 'omit',
          signal: controller.signal,
        })
        const data = await response.json()
        if (!response.ok || data.protocolVersion !== 1)
          throw new Error('服务不可用或协议版本不兼容。')
        if (current === generation && !stopped)
          store.update({ notice: '服务可达，请输入配对码连接。' })
      } catch (error: any) {
        if (current === generation && !stopped)
          store.update({
            notice:
              error.message === 'Failed to fetch'
                ? '无法连接，请检查地址、网络、证书或跨域配置。'
                : error.message,
          })
      } finally {
        clearTimeout(timeout)
        controllers.delete(controller)
      }
    },
    disconnect() {
      restoreDraft()
      blocked = true
      disconnect()
      store.update({ settingsOpen: true, connectionMessage: '编辑服务已断开。' })
    },
    snapshot: (): ConnectionMemory => ({ pending: [...pending.values()], endpoint, sessionId }),
    stop() {
      if (stopped) return
      stopped = true
      disconnect()
      unsubscribe()
    },
  }
}
