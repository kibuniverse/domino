import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { relative } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import type { Plugin } from 'vite'
import type { IncomingMessage } from 'node:http'
import { instrument, hash } from '../transform/index'
import { SourceRegistry, within } from '../core/registry'
import { TaskManager } from '../core/tasks'
import { DEFAULT_DIRS, editable, validateDirectories } from '../core/files'
import { parseCreate } from '../core/protocol'
import { DominoError, errorMessage } from '../core/types'
import type { Task } from '../core/types'
import { createAgent } from '../agents/index'
import type { AgentConfig } from '../agents/index'

export interface DominoOptions {
  agent?: AgentConfig
  shortcut?: string | string[]
  directories?: string[]
  execution?: { timeoutMs?: number; queueLimit?: number }
  allowLan?: boolean
}
export function isLoopback(address?: string): boolean {
  return !!address && (address === '::1' || /^127\./.test(address) || /^::ffff:127\./.test(address))
}
export function allowedConnection(request: IncomingMessage, https: boolean, allowLan = false): boolean {
  if ((!allowLan && !isLoopback(request.socket.remoteAddress)) || !request.headers.host || !request.headers.origin) return false
  try {
    const origin = new URL(request.headers.origin)
    const host = new URL(`${https ? 'https' : 'http'}://${request.headers.host}`)
    return (allowLan || ['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)) && origin.origin === host.origin
  } catch { return false }
}

export function domino(options: DominoOptions = {}): Plugin {
  let root = ''
  let base = '/'
  let registry: SourceRegistry
  let manager: TaskManager | undefined
  let ws: WebSocketServer | undefined
  let cleanup: (() => Promise<void>) | undefined
  const token = randomBytes(32).toString('hex')
  const sessionId = randomUUID()
  const directories = validateDirectories(options.directories ?? DEFAULT_DIRS)
  const allowLan = options.allowLan ?? false
  const timeoutMs = options.execution?.timeoutMs ?? 300000
  const queueLimit = options.execution?.queueLimit ?? 3
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1800000 || !Number.isInteger(queueLimit) || queueLimit < 1 || queueLimit > 10) throw new DominoError('INVALID_CONFIG', '任务超时或队列配置无效。')
  const virtualId = 'virtual:domino/runtime'
  const resolvedId = `\0${virtualId}`
  const runtimeEntry = () => fileURLToPath(import.meta.url.endsWith('.ts') ? new URL('../runtime/index.ts', import.meta.url) : new URL('./runtime.mjs', import.meta.url))
  return {
    name: 'domino',
    enforce: 'pre',
    apply: 'serve',
    async configResolved(config) { root = await realpath(config.root); base = config.base; registry = new SourceRegistry(root) },
    resolveId(id) { if (id === virtualId) return resolvedId },
    async load(id) {
      if (id !== resolvedId) return
      // Bundled plugin and runtime are sibling entries. Source imports use the TS runtime.
      return `export { mountDomino, reportVersion } from ${JSON.stringify(runtimeEntry())}`
    },
    async transform(code, id) {
      const path = id.split('?')[0]
      if (id.startsWith('\0') || !within(root, path) || !/\.[cm]?[jt]sx?$/.test(path)) return
      const file = relative(root, path).split('\\').join('/')
      if (!editable(file, directories)) return
      if (await realpath(path) !== path) return
      // Refuse transformed source positions rather than attributing them to original code.
      if (hash(await readFile(path, 'utf8')) !== hash(code)) { this.warn(`domino: skipped ${file}; place domino before source-transforming plugins.`); return }
      let reporter = `__domino_${hash(code).slice(0, 16)}`
      while (code.includes(reporter)) reporter += '_'
      const result = instrument(code, file, `\nimport { reportVersion as ${reporter} } from ${JSON.stringify(virtualId)};\n${reporter}(${JSON.stringify(file)}, ${JSON.stringify(hash(code))});\n`)
      registry.replace(file, result.records)
      return { code: result.code, map: result.map }
    },
    transformIndexHtml() {
      const shortcutList = Array.isArray(options.shortcut) ? options.shortcut : options.shortcut ? [options.shortcut] : ['Alt+Space', 'Space']
      const shortcuts = [...new Set(shortcutList.map(shortcut => shortcut.trim()).filter(Boolean))]
      const config = { token, sessionId, wsPath: `${base}__domino/ws`, shortcuts }
      return [{ tag: 'script', attrs: { type: 'module' }, children: `import { mountDomino } from ${JSON.stringify(`${base}@id/${virtualId}`)}; mountDomino(${JSON.stringify(config).replace(/</g, '\\u003c')});`, injectTo: 'head-prepend' }]
    },
    async configureServer(server) {
      if (!server.httpServer) throw new DominoError('UNSUPPORTED_SERVER', '第一版需要 Vite 自带 HTTP 服务，不支持 middleware mode。')
      if (!base.startsWith('/') || !base.endsWith('/')) throw new DominoError('INVALID_BASE', '第一版要求 Vite base 为以 / 开始和结束的路径。')
      // Use Vite resolution so projects using dependency aliases are supported too.
      for (const dependency of ['react', 'react/jsx-runtime', 'react-dom/client']) {
        if (!await server.environments.client.pluginContainer.resolveId(dependency, runtimeEntry())) {
          throw new DominoError('RUNTIME_DEPENDENCY_MISSING', 'Domino 面板需要 React 19 和 React DOM 19，请安装：npm install react@^19 react-dom@^19')
        }
      }
      // Install before Vite's file/import handlers, including /@fs/ and ?raw.
      // Keep the project's existing fs.deny policy intact.
      server.middlewares.use((request, response, next) => {
        let path: string
        try { path = decodeURIComponent((request.url ?? '').split('?')[0]).replaceAll('\\', '/') }
        catch { response.statusCode = 400; response.end('Invalid URL'); return }
        if (/(?:^|\/)\.domino(?:\/|$)/i.test(path)) {
          response.statusCode = 403
          response.end('Forbidden')
          return
        }
        next()
      })
      const agent = await createAgent(options.agent)
      manager = new TaskManager({ root, registry, agent, directories, timeoutMs, queueLimit })
      try { await manager.initialize() } catch (error) { await manager.close(); throw error }
      ws = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false })
      const sockets = new Set<WebSocket>()
      const send = (socket: WebSocket, value: unknown) => {
        if (socket.readyState !== WebSocket.OPEN) return
        if (socket.bufferedAmount > 2 * 1024 * 1024) { socket.close(1008, 'Client too slow'); return }
        socket.send(JSON.stringify(value))
      }
      const onTask = (task: Task) => { for (const socket of sockets) send(socket, { type: 'task.snapshot', task }) }
      manager.on('task', onTask)
      const upgrade = (request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
        if (request.url?.split('?')[0] !== `${base}__domino/ws`) return
        if (!allowedConnection(request, !!server.config.server.https, allowLan) || ws!.clients.size >= 8) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return }
        ws!.handleUpgrade(request, socket, head, connection => ws!.emit('connection', connection, request))
      }
      server.httpServer.on('upgrade', upgrade)
      ws.on('connection', socket => {
        let authenticated = false
        let count = 0
        let intervalStart = Date.now()
        const authTimeout = setTimeout(() => socket.close(1008, 'Authentication required'), 5000)
        socket.on('error', () => {})
        socket.on('close', () => { clearTimeout(authTimeout); sockets.delete(socket) })
        socket.on('message', data => {
          void (async () => {
            let request: Record<string, any>
            try {
              request = JSON.parse(data.toString())
              if (!request || typeof request !== 'object' || Array.isArray(request)) throw new DominoError('INVALID_REQUEST', '无效请求。')
              if (Date.now() - intervalStart > 10000) { count = 0; intervalStart = Date.now() }
              if (++count > 100) { socket.close(1008, 'Rate limit'); return }
              if (!authenticated) {
                const provided = typeof request.token === 'string' ? Buffer.from(request.token) : Buffer.alloc(0)
                if (request.type !== 'hello' || request.protocolVersion !== 1 || request.sessionId !== sessionId || provided.length !== token.length || !timingSafeEqual(provided, Buffer.from(token))) { socket.close(1008, 'Authentication failed'); return }
                authenticated = true
                clearTimeout(authTimeout)
                sockets.add(socket)
                send(socket, { type: 'ready', diagnostic: manager!.diagnostic, tasks: manager!.list() })
                return
              }
              const requestId = typeof request.requestId === 'string' && request.requestId.length <= 100 ? request.requestId : undefined
              if (request.type === 'task.create') {
                const input = parseCreate(request)
                const task = await manager!.create(input.requestId, input.context)
                send(socket, { type: 'reply', requestId, taskId: task.id })
              } else if (['task.cancel', 'task.undo', 'task.pageUpdated'].includes(request.type)) {
                if (typeof request.taskId !== 'string' || request.taskId.length > 100) throw new DominoError('INVALID_REQUEST', '无效任务 ID。')
                if (request.type === 'task.cancel') await manager!.cancel(request.taskId)
                else if (request.type === 'task.undo') await manager!.undo(request.taskId)
                else {
                  const versions: Record<string, string> = {}
                  if (request.versions && typeof request.versions === 'object') for (const [key, value] of Object.entries(request.versions).slice(0, 1000)) if (key.length < 500 && typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) versions[key] = value
                  await manager!.pageUpdated(request.taskId, versions)
                }
                send(socket, { type: 'reply', requestId })
              } else throw new DominoError('INVALID_REQUEST', '未知请求类型。')
            } catch (error) { send(socket, { type: 'reply', requestId: typeof request!?.requestId === 'string' ? request!.requestId.slice(0, 100) : undefined, error: errorMessage(error) }) }
          })().catch(() => socket.close(1011, 'Internal error'))
        })
      })
      const onUnlink = (path: string) => registry.remove(relative(root, path).split('\\').join('/'))
      server.watcher.on('unlink', onUnlink)
      let closing: Promise<void> | undefined
      cleanup = () => closing ??= (async () => {
        server.httpServer?.off('upgrade', upgrade)
        server.watcher.off('unlink', onUnlink)
        manager!.off('task', onTask)
        for (const socket of ws!.clients) socket.terminate()
        ws!.close()
        await manager!.close()
      })()
      server.httpServer.on('close', () => { void cleanup!().catch(error => server.config.logger.error(errorMessage(error))) })
      server.config.logger.info(`domino: ${manager.diagnostic.message}`)
      if (allowLan) server.config.logger.warn('domino: allowLan 已开启，局域网内任何能打开页面的设备都可以驱动 Agent 修改本项目源码。')
    },
    async closeBundle() { await cleanup?.() }
  }
}
