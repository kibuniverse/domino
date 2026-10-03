import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Compiler } from 'webpack'

import { DominoError, errorMessage } from '../core/types'
import { protectStorage } from '../integration/http'
import { normalizeOptions, validateBase } from '../integration/options'
import { assertRuntimeDependencies } from '../integration/runtime-dependencies'
import { DominoSession } from '../integration/session'
import type { Logger } from '../integration/session'
import { SESSION, getSession } from './bridge'
import type { BundlerOptions, DominoDevServer } from './types'
interface Middleware {
  name: string
  middleware(request: IncomingMessage, response: ServerResponse, next: () => void): void
}

/** Prepend bootstrap without changing entry names, ordering, or descriptors. */
export function injectBootstrap(entry: any, bootstrap: string): any {
  if (typeof entry === 'string') return [bootstrap, entry]
  if (Array.isArray(entry)) return [bootstrap, ...entry]
  return Object.fromEntries(
    Object.entries(entry).map(([name, value]) => [
      name,
      typeof value === 'string' || Array.isArray(value)
        ? injectBootstrap(value, bootstrap)
        : {
            ...(value as object),
            import: [bootstrap, ...((value as { import?: string[] }).import ?? [])],
          },
    ]),
  )
}

export function createBundlerPlugin(options: BundlerOptions = {}) {
  const normalized = normalizeOptions(options)
  const base = validateBase(options.base ?? '/')
  let compiler: Compiler | undefined
  let session: DominoSession | undefined
  let logger: Logger
  let active = false
  let initialized = false
  const asset = (name: string) => fileURLToPath(new URL(`./${name}`, import.meta.url))
  const runtimeEntry = asset('runtime-webpack.mjs')
  const bootstrap = `!!${asset('domino-bootstrap.cjs')}!${runtimeEntry}`
  const close = async () => {
    active = false
    if (compiler) {
      const context = getSession(compiler)
      if (context) context.active = false
    }
    await session?.close()
  }
  return {
    apply(target: Compiler) {
      if (compiler)
        throw new DominoError('INVALID_CONFIG', '每个 compiler 必须使用独立的 Domino 插件实例。')
      compiler = target
      if (compiler.options.mode !== 'development') return
      const targetOption = compiler.options.target
      if (
        targetOption !== undefined &&
        targetOption !== false &&
        !(Array.isArray(targetOption) ? targetOption : [targetOption]).some((target) =>
          /^web(?:$|\b)/.test(target),
        )
      )
        throw new DominoError('UNSUPPORTED_TARGET', 'Domino 仅支持浏览器 React 项目。')
      if (getSession(compiler))
        throw new DominoError('INVALID_CONFIG', '同一个 compiler 不能重复配置 Domino。')
      session = new DominoSession(compiler.context, base, normalized)
      Object.defineProperty(compiler, SESSION, {
        value: { active: false, session, runtimeEntry },
        configurable: true,
      })
      logger = compiler.getInfrastructureLogger('domino')
      const entry = compiler.options.entry
      if (typeof entry === 'function')
        compiler.options.entry = async () => {
          const resolved = await entry()
          return active ? injectBootstrap(resolved, bootstrap) : resolved
        }
      compiler.options.module.rules.unshift({
        test: /\.[cm]?[jt]sx?$/,
        include: (path) => session!.isSourcePath(path),
        enforce: 'pre',
        use: [{ loader: asset('domino-instrument.cjs') }],
      })
      compiler.hooks.watchRun.tapPromise('domino', async () => {
        if (!active) return
        try {
          if (!initialized) {
            const resolver = compiler!.resolverFactory.get('normal')
            await assertRuntimeDependencies(
              (dependency) =>
                new Promise<boolean>((resolve) => {
                  resolver.resolve({}, dirname(runtimeEntry), dependency, {}, (error, result) =>
                    resolve(!error && !!result),
                  )
                }),
            )
          }
          await session!.initialize()
          if (!initialized) {
            initialized = true
            session!.logReady(logger)
          }
          for (const path of compiler!.removedFiles ?? []) session!.remove(path)
        } catch (error) {
          await close()
          throw error
        }
      })
      compiler.hooks.done.tap('domino', (stats) => {
        if (active)
          session!.reportBuild(
            stats.hasErrors()
              ? (stats.toJson({ all: false, errors: true }).errors ?? [])
                  .map((error) => error.message)
                  .join('\n')
              : '',
          )
      })
      compiler.hooks.failed.tap('domino', (error) => {
        if (active) session!.reportBuild(errorMessage(error))
      })
      compiler.hooks.shutdown.tapPromise('domino', close)
      compiler.hooks.watchClose.tap('domino', () => {
        void close().catch((error) => logger.error(errorMessage(error)))
      })
    },
    setupMiddlewares<T>(middlewares: T[], devServer: DominoDevServer): T[] {
      if (!compiler) throw new DominoError('INVALID_CONFIG', '先将同一 Domino 实例配置到 plugins。')
      if (compiler.options.mode !== 'development') return middlewares
      if (devServer.compiler !== compiler || !devServer.server)
        throw new DominoError(
          'UNSUPPORTED_SERVER',
          'Domino 需要与插件相同的单 compiler 开发服务器。',
        )
      if (active) return middlewares
      if (initialized)
        throw new DominoError(
          'SERVER_CLOSING',
          '重新启动服务器时请创建新的 compiler 和 Domino 实例。',
        )
      const server = devServer.options.server
      const type =
        typeof server === 'string' ? server : (server as { type?: string } | undefined)?.type
      session!.attach(
        devServer.server,
        type === 'https' || type === 'http2' || type === 'spdy',
        logger,
      )
      // Static entries stay static so HTML plugins can inspect their original names.
      // The server attaches before compilation, just like its own HMR EntryPlugins.
      if (typeof compiler.options.entry !== 'function') {
        for (const name of Object.keys(compiler.options.entry)) {
          new compiler.webpack.EntryPlugin(compiler.context, bootstrap, { name }).apply(compiler)
        }
      }
      active = true
      getSession(compiler)!.active = true
      ;(middlewares as Array<T | Middleware>).unshift({
        name: 'domino-storage-protection',
        middleware: protectStorage,
      })
      return middlewares
    },
  }
}
