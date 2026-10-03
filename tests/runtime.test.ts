import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Task, VisualContext } from '../src/core/types'
import { createStore, capabilities } from '../src/runtime/store'
import { createConnection } from '../src/runtime/connection'
import { reportVersion } from '../src/runtime/versions'

class Socket {
  static OPEN = 1
  static instances: Socket[] = []
  readyState = 0
  sent: any[] = []
  onopen?: () => void
  onmessage?: (event: { data: string }) => void
  onclose?: (event: { code: number }) => void
  onerror?: () => void
  constructor(public url: string) { Socket.instances.push(this) }
  send(data: string) { this.sent.push(JSON.parse(data)) }
  open() { this.readyState = 1; this.onopen?.() }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code }) }
}
const config = { token: 'test-token', sessionId: 'session', wsPath: '/preview/__domino/ws', shortcuts: ['Space'] }
const context: VisualContext = { sourceId: `s_${'a'.repeat(24)}`, instruction: '修改按钮', scope: 'auto', locator: 'exact', route: '/', element: { tagName: 'button', text: '创建', rect: { x: 0, y: 0, width: 40, height: 30 }, styles: {} } }
const task = (seq: number): Task => ({ id: 'task-1', requestId: 'request-1', instruction: context.instruction, status: 'running', source: { sourceId: context.sourceId, file: 'src/App.tsx', fileHash: 'a'.repeat(64), tagName: 'button', start: { line: 1, column: 1 }, end: { line: 1, column: 9 } }, createdAt: '2026-10-03T00:00:00Z', seq, logs: [], changes: [], applied: false, undone: false, pageUpdate: 'not_applicable' })
let frames: FrameRequestCallback[]
const connections: ReturnType<typeof createConnection>[] = []
beforeEach(() => {
  vi.useFakeTimers()
  Socket.instances = []
  frames = []
  vi.stubGlobal('WebSocket', Socket)
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
})
afterEach(() => {
  for (const connection of connections.splice(0)) connection.stop()
  vi.unstubAllGlobals(); vi.useRealTimers()
})
function connect() {
  const store = createStore()
  const connection = createConnection(config, store)
  connections.push(connection); connection.start()
  const socket = Socket.instances[0]
  socket.open()
  socket.receive({ type: 'ready', diagnostic: { ready: true, message: '可用' }, tasks: [] })
  return { store, connection, socket }
}

test('store snapshots stay stable between changes and disabled actions reflect selection/network state', () => {
  const store = createStore({ ready: true, diagnostic: { ready: true, message: '可用' }, context, draft: '修改' })
  const snapshot = store.getSnapshot()
  store.update({ draft: '修改' })
  expect(store.getSnapshot()).toBe(snapshot)
  expect(capabilities(snapshot).submit).toBe(true)
  store.update({ stale: true })
  expect(capabilities(store.getSnapshot()).submit).toBe(false)
  store.update({ stale: false, pendingCreate: true })
  expect(capabilities(store.getSnapshot()).submit).toBe(false)
})

test('reconnect reuses the request ID and recovers the submitted instruction after a rejected reply', () => {
  const { store, connection, socket } = connect()
  expect(socket.url).toBe('ws://localhost:5173/preview/__domino/ws')
  expect(socket.sent[0]).toEqual({ type: 'hello', protocolVersion: 1, token: config.token, sessionId: config.sessionId })
  const request = { type: 'task.create', requestId: 'request-1', context }
  connection.send(request, true)
  expect(store.getSnapshot().pendingCreate).toBe(true)
  socket.close()
  vi.advanceTimersByTime(500)
  const next = Socket.instances[1]
  next.open(); next.receive({ type: 'ready', diagnostic: { ready: true, message: '可用' }, tasks: [] })
  expect(next.sent[1]).toEqual(request)
  next.receive({ type: 'reply', requestId: 'request-1', error: '源码已失效' })
  expect(store.getSnapshot()).toMatchObject({ pendingCreate: false, draft: context.instruction, notice: '源码已失效' })
})

test('older task snapshots cannot replace new state and version reports made before mount are acknowledged', () => {
  reportVersion('src/App.tsx', 'b'.repeat(64))
  const { store, socket } = connect()
  const newer = { ...task(3), status: 'completed', applied: true, pageUpdate: 'pending', changes: [{ path: 'src/App.tsx', patch: 'diff' }] }
  socket.receive({ type: 'task.snapshot', task: newer })
  expect(socket.sent.at(-1)).toMatchObject({ type: 'task.pageUpdated', taskId: 'task-1', versions: { 'src/App.tsx': 'b'.repeat(64) } })
  socket.receive({ type: 'task.snapshot', task: task(2) })
  expect(store.getSnapshot().tasks[0]).toEqual(newer)
  frames.splice(0).forEach(callback => callback(0))
})

test('stopping a connection cancels reconnects and detaches module-version listeners', () => {
  const { connection, socket } = connect()
  socket.close()
  connection.stop(); connection.stop()
  vi.advanceTimersByTime(10000)
  expect(Socket.instances).toHaveLength(1)
  const count = socket.sent.length
  reportVersion('src/App.tsx', 'c'.repeat(64))
  frames.splice(0).forEach(callback => callback(0))
  expect(socket.sent).toHaveLength(count)
})

test('a recreated runtime retains pending create requests without generating new IDs', () => {
  const { connection } = connect()
  const request = { type: 'task.create', requestId: 'request-hmr', context }
  connection.send(request, true)
  const memory = connection.snapshot()
  connection.stop()
  const store = createStore()
  const next = createConnection(config, store, memory)
  connections.push(next); next.start()
  const socket = Socket.instances.at(-1)!
  socket.open(); socket.receive({ type: 'ready', diagnostic: { ready: true, message: '可用' }, tasks: [] })
  expect(socket.sent[1]).toEqual(request)
  expect(store.getSnapshot().pendingCreate).toBe(true)
  socket.receive({ type: 'reply', requestId: request.requestId, taskId: 'task-1' })
  expect(store.getSnapshot()).toMatchObject({ activeId: 'task-1', pendingCreate: false })
})

test('compiler diagnostics arrive over the shared transport and clear after recovery/reconnect', () => {
  const { store, socket } = connect()
  socket.receive({ type: 'build.status', error: 'SyntaxError: invalid JSX' })
  expect(store.getSnapshot().buildError).toBe('编译诊断：SyntaxError: invalid JSX')
  socket.receive({ type: 'build.status', error: '' })
  expect(store.getSnapshot().buildError).toBe('')
  socket.receive({ type: 'ready', diagnostic: { ready: true, message: '可用' }, tasks: [], buildError: 'still broken' })
  expect(store.getSnapshot().buildError).toBe('编译诊断：still broken')
})
