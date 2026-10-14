import { randomBytes } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'

import { DominoError } from '../core/types'
import type { DominoOptions } from '../integration/options'
import { normalizeOptions } from '../integration/options'
import { DominoSession } from '../integration/session'

export interface ServiceOptions extends Omit<DominoOptions, 'deployment' | 'allowLan'> {
  projectId: string
  root: string
  manifest: string | string[]
  host?: string
  port?: number
  allowedOrigins: string[]
}
export async function startDominoService(options: ServiceOptions) {
  if (
    !options ||
    typeof options.projectId !== 'string' ||
    typeof options.root !== 'string' ||
    !/^[\w-]{1,80}$/.test(options.projectId) ||
    !Array.isArray(options.allowedOrigins) ||
    !options.allowedOrigins.length
  )
    throw new DominoError('INVALID_CONFIG', '需要有效的 projectId 和 allowedOrigins。')
  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
  )
    throw new DominoError('INVALID_CONFIG', 'port 必须是 0–65535 的整数。')
  for (const origin of options.allowedOrigins) {
    const url = new URL(origin)
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin)
      throw new DominoError('INVALID_CONFIG', 'allowedOrigins 必须为精确的 HTTP/HTTPS 页面来源。')
  }
  const root = await realpath(options.root)
  const paths = Array.isArray(options.manifest) ? options.manifest : [options.manifest]
  if (!paths.length || paths.some((path) => typeof path !== 'string' || !path))
    throw new DominoError('INVALID_CONFIG', '需要源码映射 manifest 路径。')
  const pairingCode = randomBytes(18).toString('base64url')
  const session = new DominoSession(root, '/', normalizeOptions(options), {
    projectId: options.projectId,
    allowedOrigins: options.allowedOrigins,
    pairingCode,
    manifests: paths.map((path) => resolve(root, path)),
  })
  const server = createServer((request, response) =>
    session.middleware(request, response, () => {
      response.statusCode = 404
      response.end('Not found')
    }),
  )
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  try {
    await session.initialize()
    session.attach(server, false, console)
    await new Promise<void>((done, reject) => {
      const error = (reason: Error) => reject(reason)
      server.once('error', error)
      server.listen(options.port ?? 8787, options.host ?? '127.0.0.1', () => {
        server.off('error', error)
        done()
      })
    })
  } catch (error) {
    await session.close()
    throw error
  }
  let closing: Promise<void> | undefined
  return {
    server,
    pairingCode,
    async close() {
      return (closing ??= (async () => {
        await session.close()
        await new Promise<void>((done) => {
          server.close(() => done())
          server.closeAllConnections()
        })
      })())
    },
  }
}
