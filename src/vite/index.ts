import { realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import type { Plugin } from 'vite'

import { DominoError } from '../core/types'
import { protectStorage } from '../integration/http'
import { normalizeOptions } from '../integration/options'
import type { DominoOptions } from '../integration/options'
import { assertRuntimeDependencies } from '../integration/runtime-dependencies'
import { DominoSession } from '../integration/session'
export type { DominoOptions } from '../integration/options'
export { isLoopback, allowedConnection } from '../integration/http'

export function domino(options: DominoOptions = {}): Plugin {
  const normalized = normalizeOptions(options)
  let session: DominoSession
  let detachWatcher: (() => void) | undefined
  const virtualId = 'virtual:domino/runtime'
  const resolvedId = `\0${virtualId}`
  const runtimeEntry = () =>
    fileURLToPath(
      import.meta.url.endsWith('.ts')
        ? new URL('../runtime/index.ts', import.meta.url)
        : new URL('./runtime.mjs', import.meta.url),
    )
  return {
    name: 'domino',
    enforce: 'pre',
    apply: 'serve',
    async configResolved(config) {
      session = new DominoSession(await realpath(config.root), config.base, normalized)
    },
    resolveId(id) {
      if (id === virtualId) return resolvedId
    },
    load(id) {
      if (id === resolvedId)
        return `export { mountDomino, reportVersion } from ${JSON.stringify(runtimeEntry())}`
    },
    async transform(code, id) {
      const result = await session.transform(code, id.split('?')[0], virtualId, (message) =>
        this.warn(message),
      )
      if (result) return { code: result.code, map: result.map }
    },
    transformIndexHtml() {
      return [
        {
          tag: 'script',
          attrs: { type: 'module' },
          children: `import { mountDomino } from ${JSON.stringify(`${session.base}@id/${virtualId}`)}; mountDomino(${JSON.stringify(session.runtimeConfig()).replace(/</g, '\\u003c')});`,
          injectTo: 'head-prepend',
        },
      ]
    },
    async configureServer(server) {
      if (!server.httpServer)
        throw new DominoError(
          'UNSUPPORTED_SERVER',
          '第一版需要 Vite 自带 HTTP 服务，不支持 middleware mode。',
        )
      await assertRuntimeDependencies(
        async (dependency) =>
          !!(await server.environments.client.pluginContainer.resolveId(
            dependency,
            runtimeEntry(),
          )),
      )
      server.middlewares.use(protectStorage)
      await session.initialize()
      session.attach(server.httpServer, !!server.config.server.https, server.config.logger)
      const onUnlink = (path: string) => session.remove(path)
      server.watcher.on('unlink', onUnlink)
      detachWatcher = () => server.watcher.off('unlink', onUnlink)
      server.httpServer.once('close', () => detachWatcher?.())
      session.logReady(server.config.logger)
    },
    async closeBundle() {
      detachWatcher?.()
      await session?.close()
    },
  }
}
