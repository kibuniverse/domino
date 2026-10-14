import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Plugin } from 'vite'

import { DominoError } from '../core/types'
import { DeploymentBuild } from '../integration/deployment'
import { protectStorage } from '../integration/http'
import { normalizeOptions } from '../integration/options'
import type { DominoOptions } from '../integration/options'
import { assertRuntimeDependencies } from '../integration/runtime-dependencies'
import { DominoSession } from '../integration/session'
export type { DominoOptions } from '../integration/options'
export { isLoopback, allowedConnection } from '../integration/http'

export function domino(options: DominoOptions = {}): Plugin {
  const normalized = normalizeOptions(options)
  let session: DominoSession | DeploymentBuild
  let deployed = false
  let outputDirectory = ''
  const bootstrapId = 'virtual:domino/bootstrap'
  let detachWatcher: (() => void) | undefined
  const virtualId = 'virtual:domino/runtime'
  const resolvedId = `\0${virtualId}`
  const runtimeEntry = () =>
    fileURLToPath(
      import.meta.url.endsWith('.ts')
        ? new URL(
            deployed ? '../runtime/index-deployed.ts' : '../runtime/index.ts',
            import.meta.url,
          )
        : new URL(deployed ? './runtime-deployed.mjs' : './runtime.mjs', import.meta.url),
    )
  return {
    name: 'domino',
    enforce: 'pre',
    apply(_config, environment) {
      return environment.command === 'serve' || !!normalized.deployment
    },
    async configResolved(config) {
      deployed = config.command === 'build'
      if (deployed && (config.build.ssr || config.build.watch || config.build.lib))
        throw new DominoError('UNSUPPORTED_BUILD', '部署编辑模式仅支持浏览器单次构建。')
      const root = await realpath(config.root)
      outputDirectory = resolve(root, config.build?.outDir ?? 'dist')
      session = deployed
        ? new DeploymentBuild(root, config.base, normalized)
        : new DominoSession(root, config.base, normalized)
    },
    resolveId(id) {
      if (id === virtualId) return resolvedId
      if (id === bootstrapId) return `\0${bootstrapId}`
    },
    load(id) {
      if (id === `\0${bootstrapId}`)
        return `import { mountDomino } from ${JSON.stringify(virtualId)}; mountDomino(${JSON.stringify(session.runtimeConfig())});`
      if (id === resolvedId)
        return `export { mountDomino, reportVersion } from ${JSON.stringify(runtimeEntry())}`
    },
    async transform(code, id) {
      const result = await session.transform(code, id.split('?')[0], virtualId, (message) =>
        this.warn(message),
      )
      if (result) return { code: result.code, map: result.map }
    },
    transformIndexHtml: {
      order: 'pre',
      handler() {
        return [
          {
            tag: 'script',
            attrs: { type: 'module' },
            children: `import ${JSON.stringify(bootstrapId)};`,
            injectTo: 'head-prepend',
          },
        ]
      },
    },
    async writeBundle() {
      if (session instanceof DeploymentBuild) await session.writeManifest(outputDirectory)
    },
    async configureServer(server) {
      if (!(session instanceof DominoSession)) return
      const developmentSession = session
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
      server.middlewares.use(developmentSession.middleware)
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
      if (session instanceof DominoSession) await session.close()
    },
  }
}
