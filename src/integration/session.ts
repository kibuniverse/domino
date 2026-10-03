import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { EventEmitter } from 'node:events'
import { readFile, realpath } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { relative } from 'node:path'
import type { Duplex } from 'node:stream'

import { WebSocketServer, WebSocket } from 'ws'

import { createAgent } from '../agents/index'
import { editable } from '../core/files'
import { parseCreate } from '../core/protocol'
import { SourceRegistry, within } from '../core/registry'
import { TaskManager } from '../core/tasks'
import { DominoError, errorMessage } from '../core/types'
import type { Task } from '../core/types'
import { instrument, hash } from '../transform/index'
import { allowedConnection } from './http'
import { validateBase } from './options'
import type { NormalizedOptions } from './options'

export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** One session owns source identity and task transport across all bundler hooks. */
export class DominoSession {
  readonly token = randomBytes(32).toString('hex')
  readonly sessionId = randomUUID()
  readonly registry: SourceRegistry
  private manager?: TaskManager
  private ws?: WebSocketServer
  private sockets = new Set<WebSocket>()
  private initializing?: Promise<void>
  private closing?: Promise<void>
  private disposing?: Promise<void>
  private server?: EventEmitter
  private https = false
  private removeTaskListener?: () => void
  private upgrade?: (request: IncomingMessage, socket: Duplex, head: Buffer) => void
  private buildError = ''
  constructor(
    public root: string,
    public base: string,
    readonly options: NormalizedOptions,
  ) {
    validateBase(base)
    this.registry = new SourceRegistry(root)
  }
  runtimeConfig() {
    return {
      token: this.token,
      sessionId: this.sessionId,
      wsPath: `${this.base}__domino/ws`,
      shortcuts: this.options.shortcuts,
    }
  }
  remove(path: string) {
    this.registry.remove(relative(this.root, path).split('\\').join('/'))
  }
  isSourcePath(path: string) {
    if (path.startsWith('\0') || !within(this.root, path) || !/\.[cm]?[jt]sx?$/.test(path))
      return false
    return editable(relative(this.root, path).split('\\').join('/'), this.options.directories)
  }
  async transform(
    code: string,
    path: string,
    runtimeImport: string,
    warn: (message: string) => void,
    format: 'esm' | 'commonjs' = 'esm',
  ) {
    if (!this.isSourcePath(path)) return
    const file = relative(this.root, path).split('\\').join('/')
    const skip = () => this.registry.remove(file)
    try {
      if ((await realpath(path)) !== path) {
        skip()
        return
      }
      if (hash(await readFile(path, 'utf8')) !== hash(code)) {
        skip()
        warn(`domino: skipped ${file}; place domino before source-transforming plugins/loaders.`)
        return
      }
      let reporter = `__domino_${hash(code).slice(0, 16)}`
      while (code.includes(reporter)) reporter += '_'
      const dependency = JSON.stringify(runtimeImport)
      const binding =
        format === 'commonjs'
          ? `const { reportVersion: ${reporter} } = require(${dependency});`
          : `import { reportVersion as ${reporter} } from ${dependency};`
      const result = instrument(
        code,
        file,
        `\n${binding}\n${reporter}(${JSON.stringify(file)}, ${JSON.stringify(hash(code))});\n`,
      )
      this.registry.replace(file, result.records)
      return result
    } catch (error) {
      skip()
      throw error
    }
  }
  initialize(): Promise<void> {
    if (this.closing)
      return Promise.reject(new DominoError('SERVER_CLOSING', '开发服务器正在关闭。'))
    return (this.initializing ??= this.start().catch(async (error) => {
      const cleanup = this.dispose()
      this.closing ??= cleanup
      await cleanup
      throw error
    }))
  }
  private async start() {
    this.root = await realpath(this.root)
    this.registry.root = this.root
    const { root, base, token, sessionId, options } = this
    const { directories, timeoutMs, queueLimit, allowLan } = options
    const agent = await createAgent(options.agent)
    const manager = (this.manager = new TaskManager({
      root,
      registry: this.registry,
      agent,
      directories,
      timeoutMs,
      queueLimit,
    }))
    await manager.initialize()
    const ws = (this.ws = new WebSocketServer({
      noServer: true,
      maxPayload: 64 * 1024,
      perMessageDeflate: false,
    }))
    const sockets = this.sockets
    const send = (socket: WebSocket, value: unknown) => {
      if (socket.readyState !== WebSocket.OPEN) return
      if (socket.bufferedAmount > 2 * 1024 * 1024) {
        socket.close(1008, 'Client too slow')
        return
      }
      socket.send(JSON.stringify(value))
    }
    const onTask = (task: Task) => {
      for (const socket of sockets) send(socket, { type: 'task.snapshot', task })
    }
    manager.on('task', onTask)
    this.removeTaskListener = () => manager.off('task', onTask)
    this.upgrade = (
      request: IncomingMessage,
      socket: import('node:stream').Duplex,
      head: Buffer,
    ) => {
      if (request.url?.split('?')[0] !== `${base}__domino/ws`) return
      if (!allowedConnection(request, this.https, allowLan) || ws.clients.size >= 8) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      ws.handleUpgrade(request, socket, head, (connection) =>
        ws.emit('connection', connection, request),
      )
    }

    ws.on('connection', (socket) => {
      let authenticated = false
      let count = 0
      let intervalStart = Date.now()
      const authTimeout = setTimeout(() => socket.close(1008, 'Authentication required'), 5000)
      socket.on('error', () => {})
      socket.on('close', () => {
        clearTimeout(authTimeout)
        sockets.delete(socket)
      })
      socket.on('message', (data) => {
        void (async () => {
          let request: Record<string, any> | undefined
          try {
            request = JSON.parse(data.toString())
            if (!request || typeof request !== 'object' || Array.isArray(request))
              throw new DominoError('INVALID_REQUEST', '无效请求。')
            if (Date.now() - intervalStart > 10000) {
              count = 0
              intervalStart = Date.now()
            }
            if (++count > 100) {
              socket.close(1008, 'Rate limit')
              return
            }
            if (!authenticated) {
              const provided =
                typeof request.token === 'string' ? Buffer.from(request.token) : Buffer.alloc(0)
              if (
                request.type !== 'hello' ||
                request.protocolVersion !== 1 ||
                request.sessionId !== sessionId ||
                provided.length !== token.length ||
                !timingSafeEqual(provided, Buffer.from(token))
              ) {
                socket.close(1008, 'Authentication failed')
                return
              }
              authenticated = true
              clearTimeout(authTimeout)
              sockets.add(socket)
              send(socket, {
                type: 'ready',
                diagnostic: manager.diagnostic,
                tasks: manager.list(),
                buildError: this.buildError,
              })
              return
            }
            const requestId =
              typeof request.requestId === 'string' && request.requestId.length <= 100
                ? request.requestId
                : undefined
            if (request.type === 'task.create') {
              const input = parseCreate(request)
              const task = await manager.create(input.requestId, input.context)
              send(socket, { type: 'reply', requestId, taskId: task.id })
            } else if (['task.cancel', 'task.undo', 'task.pageUpdated'].includes(request.type)) {
              if (typeof request.taskId !== 'string' || request.taskId.length > 100)
                throw new DominoError('INVALID_REQUEST', '无效任务 ID。')
              if (request.type === 'task.cancel') await manager.cancel(request.taskId)
              else if (request.type === 'task.undo') await manager.undo(request.taskId)
              else {
                const versions: Record<string, string> = {}
                if (request.versions && typeof request.versions === 'object')
                  for (const [key, value] of Object.entries(request.versions).slice(0, 1000))
                    if (
                      key.length < 500 &&
                      typeof value === 'string' &&
                      /^[a-f0-9]{64}$/.test(value)
                    )
                      versions[key] = value
                await manager.pageUpdated(request.taskId, versions)
              }
              send(socket, { type: 'reply', requestId })
            } else throw new DominoError('INVALID_REQUEST', '未知请求类型。')
          } catch (error) {
            send(socket, {
              type: 'reply',
              requestId:
                typeof request?.requestId === 'string'
                  ? request.requestId.slice(0, 100)
                  : undefined,
              error: errorMessage(error),
            })
          }
        })().catch(() => socket.close(1011, 'Internal error'))
      })
    })
  }
  attach(server: EventEmitter, https: boolean, logger: Logger) {
    if (this.closing) throw new DominoError('SERVER_CLOSING', '开发服务器正在关闭。')
    if (this.server === server) return
    if (this.server)
      throw new DominoError('UNSUPPORTED_SERVER', '一个 Domino 会话只能绑定一个开发服务器。')
    this.server = server
    this.https = https
    server.on('upgrade', this.handleUpgrade)
    server.once('close', this.onClose)
    this.logger = logger
  }
  private logger?: Logger
  private handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (request.url?.split('?')[0] !== `${this.base}__domino/ws`) return
    if (!this.upgrade || this.closing) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    this.upgrade(request, socket, head)
  }
  private onClose = () => {
    void this.close().catch((error) => this.logger?.error(errorMessage(error)))
  }
  logReady(logger: Logger) {
    logger.info(`domino: ${this.manager!.diagnostic.message}`)
    if (this.options.allowLan)
      logger.warn(
        'domino: allowLan 已开启，局域网内任何能打开页面的设备都可以驱动 Agent 修改本项目源码。',
      )
  }
  reportBuild(error = '') {
    this.buildError = error.slice(0, 4000)
    for (const socket of this.sockets) {
      if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount <= 2 * 1024 * 1024)
        socket.send(JSON.stringify({ type: 'build.status', error: this.buildError }))
    }
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.server?.off('upgrade', this.handleUpgrade)
      this.server?.off('close', this.onClose)
      await this.initializing?.catch(() => {})
      await this.dispose()
    })())
  }
  private dispose(): Promise<void> {
    return (this.disposing ??= (async () => {
      this.server?.off('upgrade', this.handleUpgrade)
      this.server?.off('close', this.onClose)
      this.removeTaskListener?.()
      const ws = this.ws
      if (ws) {
        for (const socket of ws.clients) socket.terminate()
        await new Promise<void>((resolve) => ws.close(() => resolve()))
      }
      await this.manager?.close()
    })())
  }
}
