import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { EventEmitter } from 'node:events'
import { realpath } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

import { WebSocketServer, WebSocket } from 'ws'

import { createAgent } from '../agents/index'
import { parseCreate } from '../core/protocol'
import { TaskManager } from '../core/tasks'
import { DominoError, errorMessage } from '../core/types'
import type { Task } from '../core/types'
import { hash } from '../transform/index'
import { ManifestStore } from './deployment'
import { allowedConnection } from './http'
import { validateBase } from './options'
import type { NormalizedOptions } from './options'
import { SourceCompiler } from './source'

export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}
export interface RemoteSessionOptions {
  projectId: string
  allowedOrigins: string[]
  pairingCode: string
  manifests: string[]
}
type Reply = { type: 'reply'; requestId?: string; taskId?: string; error?: string }
const equal = (provided: unknown, expected: string) => {
  const bytes = typeof provided === 'string' ? Buffer.from(provided) : Buffer.alloc(0)
  return (
    bytes.length === Buffer.byteLength(expected) && timingSafeEqual(bytes, Buffer.from(expected))
  )
}

/** One project queue is shared by development, standalone HTTP and WebSocket clients. */
export class DominoSession extends SourceCompiler {
  readonly token = randomBytes(32).toString('hex')
  readonly sessionId = randomUUID()
  readonly manifests?: ManifestStore
  private manager?: TaskManager
  private ws?: WebSocketServer
  private sockets = new Set<WebSocket>()
  private initializing?: Promise<void>
  private closing?: Promise<void>
  private server?: EventEmitter
  private https = false
  private logger?: Logger
  private buildError = ''
  private tokens = new Map<string, { origin: string; expiresAt: number }>()
  private limits = new Map<string, { count: number; since: number }>()
  private commands = new Map<string, { fingerprint: string; result: Promise<Reply> }>()
  private removeTaskListener?: () => void
  constructor(
    root: string,
    base: string,
    options: NormalizedOptions,
    readonly remote?: RemoteSessionOptions,
  ) {
    super(root, validateBase(base), options)
    if (remote) this.manifests = new ManifestStore(this, remote.manifests, remote.projectId)
  }
  runtimeConfig() {
    return {
      token: this.token,
      sessionId: this.sessionId,
      wsPath: `${this.base}__domino/ws`,
      apiPath: `${this.base}__domino/v1/`,
      shortcuts: this.options.shortcuts,
    }
  }
  initialize(): Promise<void> {
    if (this.closing) return Promise.reject(new DominoError('SERVER_CLOSING', '编辑服务正在关闭。'))
    return (this.initializing ??= this.start())
  }
  private async start() {
    try {
      this.root = await realpath(this.root)
      this.registry.root = this.root
      await this.manifests?.reload()
      const agent = await createAgent(this.options.agent)
      const manager = (this.manager = new TaskManager({
        root: this.root,
        registry: this.registry,
        agent,
        directories: this.options.directories,
        timeoutMs: this.options.timeoutMs,
        queueLimit: this.options.queueLimit,
      }))
      await manager.initialize()
      const onTask = (task: Task) => {
        for (const socket of this.sockets) this.send(socket, { type: 'task.snapshot', task })
      }
      manager.on('task', onTask)
      this.removeTaskListener = () => manager.off('task', onTask)
      this.ws = new WebSocketServer({
        noServer: true,
        maxPayload: 64 * 1024,
        perMessageDeflate: false,
      })
      this.ws.on('connection', (socket, request) => this.onConnection(socket, request))
    } catch (error) {
      this.server?.off('upgrade', this.handleUpgrade)
      this.server?.off('close', this.onClose)
      this.closing ??= Promise.resolve()
      await this.manager?.close()
      throw error
    }
  }
  private send(socket: WebSocket, message: unknown) {
    if (socket.readyState !== WebSocket.OPEN) return
    if (socket.bufferedAmount > 2 * 1024 * 1024) return socket.close(1013, 'Client too slow')
    socket.send(JSON.stringify(message))
  }
  private allowed(request: IncomingMessage, http = false) {
    if (this.remote) {
      try {
        const host = new URL(`http://${request.headers.host}`)
        return (
          !!request.headers.host &&
          host.host === request.headers.host &&
          !host.username &&
          !host.password &&
          !!request.headers.origin &&
          this.remote.allowedOrigins.includes(request.headers.origin)
        )
      } catch {
        return false
      }
    }
    if (http && !request.headers.origin && request.headers['sec-fetch-site'] === 'same-origin') {
      // Same-origin GETs omit Origin; browser-controlled Fetch Metadata is required.
      return allowedConnection(
        {
          ...request,
          headers: {
            ...request.headers,
            origin: `${this.https ? 'https' : 'http'}://${request.headers.host}`,
          },
          socket: request.socket,
        } as IncomingMessage,
        this.https,
        this.options.allowLan,
      )
    }
    return allowedConnection(request, this.https, this.options.allowLan)
  }
  private rate(key: string, maximum = 100, windowMs = 10000) {
    const now = Date.now()
    for (const [id, limit] of this.limits) if (now - limit.since >= 60000) this.limits.delete(id)
    let limit = this.limits.get(key)
    if (!limit || now - limit.since >= windowMs) {
      if (this.limits.size >= 256) throw new DominoError('RATE_LIMIT', '连接过多，请稍后重试。')
      limit = { count: 0, since: now }
      this.limits.set(key, limit)
    }
    if (++limit.count > maximum) throw new DominoError('RATE_LIMIT', '请求过于频繁，请稍后重试。')
  }
  private async authenticate(hello: Record<string, any>, origin: string) {
    if (hello.protocolVersion !== 1)
      throw new DominoError('PROTOCOL_MISMATCH', '编辑协议版本不兼容。')
    if (this.remote) {
      const credential = this.tokens.get(hello.token)
      if (!credential || credential.origin !== origin || credential.expiresAt <= Date.now())
        throw new DominoError('AUTH_REQUIRED', '连接凭证已失效，请重新配对。')
      if (hello.projectId !== this.remote.projectId)
        throw new DominoError('PROJECT_MISMATCH', '编辑服务与页面不属于同一项目。')
      await this.manifests!.reload()
      if (!this.manifests!.has(hello.buildId))
        throw new DominoError(
          'BUILD_MISMATCH',
          '服务未加载当前页面的源码映射，请更新映射或重新部署页面。',
        )
    } else if (!equal(hello.token, this.token))
      throw new DominoError('AUTH_REQUIRED', '认证失败，请刷新页面。')
    if (hello.sessionId && hello.sessionId !== this.sessionId)
      throw new DominoError('SESSION_CHANGED', '编辑服务已重启，请刷新页面并核对已有任务。')
    if (!this.remote && hello.sessionId !== this.sessionId)
      throw new DominoError('SESSION_CHANGED', '编辑服务已重启，请刷新页面。')
  }
  private ready(seqs?: Record<string, number>) {
    const tasks = this.manager!.list()
    return {
      type: 'ready',
      sessionId: this.sessionId,
      projectId: this.remote?.projectId,
      diagnostic: this.manager!.diagnostic,
      buildError: this.buildError,
      tasks: tasks.filter((task) => !seqs || seqs[task.id] !== task.seq),
      taskIds: tasks.map((task) => task.id),
    }
  }
  private async command(request: Record<string, any>, buildId?: string): Promise<Reply> {
    if (this.closing) return { type: 'reply', error: 'SERVER_CLOSING: 编辑服务正在关闭。' }
    const requestId =
      typeof request.requestId === 'string' && /^[\w-]{8,100}$/.test(request.requestId)
        ? request.requestId
        : undefined
    if (['task.cancel', 'task.undo'].includes(request.type) && !requestId)
      return { type: 'reply', error: 'INVALID_REQUEST: 操作需要有效的请求 ID。' }
    const execute = async (): Promise<Reply> => {
      try {
        const manager = this.manager!
        if (request.type === 'task.create') {
          const input = parseCreate(request)
          // Let TaskManager resolve duplicate submissions even after the file changed.
          if (this.remote && !this.manifests!.has(buildId!, input.context.sourceId))
            throw new DominoError(
              'STALE_SELECTION',
              '当前元素不属于页面的源码映射，请重新部署页面。',
            )
          const task = await manager.create(input.requestId, input.context)
          return { type: 'reply', requestId, taskId: task.id }
        }
        if (!['task.cancel', 'task.undo', 'task.pageUpdated'].includes(request.type))
          throw new DominoError('INVALID_REQUEST', '未知请求类型。')
        if (typeof request.taskId !== 'string' || request.taskId.length > 100)
          throw new DominoError('INVALID_REQUEST', '无效任务 ID。')
        if (request.type === 'task.cancel') await manager.cancel(request.taskId)
        else if (request.type === 'task.undo') await manager.undo(request.taskId)
        else {
          const versions: Record<string, string> = {}
          if (request.versions && typeof request.versions === 'object')
            for (const [key, value] of Object.entries(request.versions).slice(0, 1000))
              if (key.length < 500 && typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
                versions[key] = value
          await manager.pageUpdated(request.taskId, versions)
        }
        return { type: 'reply', requestId }
      } catch (error) {
        return { type: 'reply', requestId, error: errorMessage(error) }
      }
    }
    if (!requestId || request.type === 'task.pageUpdated') return execute()
    const fingerprint = hash(JSON.stringify(request))
    const existing = this.commands.get(requestId)
    if (existing)
      return existing.fingerprint === fingerprint
        ? existing.result
        : { type: 'reply', requestId, error: 'REQUEST_CONFLICT: 同一请求 ID 不能用于不同操作。' }
    if (this.commands.size >= 1000)
      return { type: 'reply', requestId, error: 'SESSION_LIMIT: 请重启编辑服务。' }
    const result = execute()
    this.commands.set(requestId, { fingerprint, result })
    return result
  }
  private onConnection(socket: WebSocket, request: IncomingMessage) {
    let hello: Record<string, any> | undefined
    let authenticating = false
    const timeout = setTimeout(() => socket.close(1008, 'Authentication required'), 5000)
    socket.on('error', () => {})
    socket.on('close', () => {
      clearTimeout(timeout)
      this.sockets.delete(socket)
    })
    socket.on('message', (data) => {
      void (async () => {
        const message = JSON.parse(data.toString())
        if (!message || typeof message !== 'object' || Array.isArray(message))
          throw new DominoError('INVALID_REQUEST', '无效请求。')
        this.rate(`ws:${request.socket.remoteAddress}`)
        if (!hello) {
          if (authenticating || message.type !== 'hello')
            throw new DominoError('AUTH_REQUIRED', '需要认证。')
          authenticating = true
          await this.authenticate(message, request.headers.origin!)
          if (socket.readyState !== WebSocket.OPEN) return
          hello = message
          clearTimeout(timeout)
          this.sockets.add(socket)
          this.send(socket, this.ready())
          return
        }
        // Check expiration/session on every command, not just the handshake.
        await this.authenticate(hello, request.headers.origin!)
        if (message.type === 'ping') {
          this.send(socket, { type: 'pong' })
          return
        }
        this.send(socket, await this.command(message, hello.buildId))
      })().catch((error) => {
        this.send(socket, { type: 'error', error: errorMessage(error) })
        socket.close(1008, 'Request rejected')
      })
    })
  }
  middleware = (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const prefix = `${this.base}__domino/v1/`
    const path = (request.url ?? '').split('?')[0]
    if (!path.startsWith(prefix)) {
      next()
      return
    }
    void this.http(request, response, path.slice(prefix.length)).catch((error) => {
      const code = error instanceof DominoError ? error.code : 'INTERNAL_ERROR'
      const status =
        code === 'AUTH_REQUIRED'
          ? 401
          : ['SESSION_CHANGED', 'PROJECT_MISMATCH', 'BUILD_MISMATCH'].includes(code)
            ? 409
            : code === 'RATE_LIMIT'
              ? 429
              : 400
      this.json(response, { error: errorMessage(error) }, status)
    })
  }
  private json(response: ServerResponse, value: unknown, status = 200) {
    if (response.destroyed || response.writableEnded) return
    response.statusCode = status
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.end(JSON.stringify(value))
  }
  private async http(request: IncomingMessage, response: ServerResponse, route: string) {
    if (!this.allowed(request, true)) {
      this.json(response, { error: 'ORIGIN_REJECTED: 页面来源未被允许。' }, 403)
      return
    }
    if (this.remote) {
      response.setHeader('Access-Control-Allow-Origin', request.headers.origin!)
      response.setHeader('Vary', 'Origin')
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    }
    if (request.method === 'OPTIONS') {
      response.statusCode = 204
      response.end()
      return
    }
    if (this.closing || !this.manager) {
      this.json(response, { error: 'SERVER_CLOSING: 服务暂不可用。' }, 503)
      return
    }
    if (route === 'health' && request.method === 'GET') {
      this.json(response, { protocolVersion: 1 })
      return
    }
    if (request.method !== 'POST' || !['pair', 'session', 'sync', 'command'].includes(route)) {
      this.json(response, { error: 'NOT_FOUND' }, 404)
      return
    }
    this.rate(`http:${request.socket.remoteAddress}`)
    if (!request.headers['content-type']?.startsWith('application/json'))
      throw new DominoError('INVALID_REQUEST', '需要 JSON 请求。')
    const chunks: Buffer[] = []
    let length = 0
    for await (const chunk of request) {
      length += chunk.length
      if (length > 64 * 1024) throw new DominoError('INVALID_REQUEST', '请求超过大小限制。')
      chunks.push(chunk)
    }
    const body = JSON.parse(Buffer.concat(chunks).toString())
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new DominoError('INVALID_REQUEST', '无效请求。')
    if (route === 'pair') {
      if (!this.remote) throw new DominoError('AUTH_REQUIRED', '开发服务不支持配对。')
      this.rate(`pair:${request.socket.remoteAddress}`, 5, 60000)
      if (body.projectId !== this.remote.projectId)
        throw new DominoError('PROJECT_MISMATCH', '项目不匹配。')
      if (!equal(body.code, this.remote.pairingCode))
        throw new DominoError('AUTH_REQUIRED', '配对码无效。')
      const now = Date.now()
      for (const [token, value] of this.tokens)
        if (value.expiresAt <= now) this.tokens.delete(token)
      if (this.tokens.size >= 32) throw new DominoError('RATE_LIMIT', '配对会话过多，请稍后重试。')
      const token = randomBytes(32).toString('hex')
      const expiresAt = now + 8 * 60 * 60 * 1000
      this.tokens.set(token, { origin: request.headers.origin!, expiresAt })
      this.json(response, {
        token,
        expiresAt,
        sessionId: this.sessionId,
        projectId: this.remote.projectId,
      })
      return
    }
    const hello = body.hello
    if (!hello || typeof hello !== 'object') throw new DominoError('AUTH_REQUIRED', '需要认证。')
    await this.authenticate(hello, request.headers.origin ?? '')
    if (route === 'command') {
      if (!body.request || typeof body.request !== 'object' || Array.isArray(body.request))
        throw new DominoError('INVALID_REQUEST', '无效操作。')
      this.json(response, await this.command(body.request, hello.buildId))
    } else
      this.json(
        response,
        this.ready(
          route === 'sync' && body.seqs && typeof body.seqs === 'object' ? body.seqs : undefined,
        ),
      )
  }
  attach(server: EventEmitter, https: boolean, logger: Logger) {
    if (this.closing) throw new DominoError('SERVER_CLOSING', '编辑服务正在关闭。')
    if (this.server === server) return
    if (this.server)
      throw new DominoError('UNSUPPORTED_SERVER', '一个 Domino 会话只能绑定一个服务器。')
    this.server = server
    this.https = https
    this.logger = logger
    server.on('upgrade', this.handleUpgrade)
    server.once('close', this.onClose)
  }
  private handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = request.url?.split('?')[0]
    if (path !== `${this.base}__domino/ws` && path !== `${this.base}__domino/v1/ws`) return
    if (!this.ws || this.closing || !this.allowed(request) || this.ws.clients.size >= 8) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    this.ws.handleUpgrade(request, socket, head, (connection) =>
      this.ws!.emit('connection', connection, request),
    )
  }
  private onClose = () => {
    void this.close().catch((error) => this.logger?.error(errorMessage(error)))
  }
  logReady(logger: Logger) {
    logger.info(`domino: ${this.manager!.diagnostic.message}`)
    if (this.options.allowLan && !this.remote)
      logger.warn(
        'domino: allowLan 已开启，局域网内任何能打开页面的设备都可以驱动 Agent 修改本项目源码。',
      )
  }
  reportBuild(error = '') {
    this.buildError = error.slice(0, 4000)
    for (const socket of this.sockets)
      this.send(socket, { type: 'build.status', error: this.buildError })
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.server?.off('upgrade', this.handleUpgrade)
      this.server?.off('close', this.onClose)
      await this.initializing?.catch(() => {})
      this.removeTaskListener?.()
      if (this.ws) {
        for (const socket of this.ws.clients) socket.terminate()
        await new Promise<void>((resolve) => this.ws!.close(() => resolve()))
      }
      await Promise.allSettled([...this.commands.values()].map((command) => command.result))
      await this.manager?.close()
      this.tokens.clear()
      this.commands.clear()
    })())
  }
}
