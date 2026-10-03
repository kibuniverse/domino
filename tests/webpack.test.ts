import { expect, test, vi } from 'vitest'
import { injectBootstrap, createBundlerPlugin } from '../src/webpack/plugin'
import { SESSION } from '../src/webpack/bridge'
import instrumentLoader from '../src/webpack/instrument-loader'
import bootstrapLoader from '../src/webpack/bootstrap-loader'

const bootstrap = '/internal/bootstrap'
test('entry injection preserves descriptors, dependencies and ordering without mutating the input', () => {
  expect(injectBootstrap('./src/main.tsx', bootstrap)).toEqual([bootstrap, './src/main.tsx'])
  expect(injectBootstrap(['./a', './b'], bootstrap)).toEqual([bootstrap, './a', './b'])
  const entries = { vendor: ['react'], main: { import: ['./main'], dependOn: 'vendor', filename: 'main.js', runtime: false } }
  expect(injectBootstrap(entries, bootstrap)).toEqual({ vendor: [bootstrap, 'react'], main: { import: [bootstrap, './main'], dependOn: 'vendor', filename: 'main.js', runtime: false } })
  expect(entries.main.import).toEqual(['./main'])
})
function compiler(mode = 'development') {
  const hook = () => ({ tap: vi.fn(), tapPromise: vi.fn() })
  return { context: process.cwd(), options: { mode, target: 'web', entry: { main: { import: ['./main'] } }, module: { rules: [] } }, hooks: { watchRun: hook(), done: hook(), failed: hook(), shutdown: hook(), watchClose: hook() }, getInfrastructureLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }
}
test('production plugins and development builds without a server do not inject runtime', async () => {
  const production = compiler('production')
  const entry = production.options.entry
  const plugin = createBundlerPlugin()
  plugin.apply(production as any)
  expect(production.options.entry).toBe(entry)
  expect(production.options.module.rules).toEqual([])
  expect(plugin.setupMiddlewares([], { compiler: production, options: {} })).toEqual([])
  const dev = compiler()
  createBundlerPlugin().apply(dev as any)
  expect(dev.options.entry).toEqual(entry)
  expect((dev as any)[SESSION].active).toBe(false)
})
test('async entry functions remain async and only active sessions receive bootstrap', async () => {
  const dev = compiler()
  dev.options.entry = (async () => ({ main: { import: ['./dynamic'], filename: 'dynamic.js' } })) as any
  const plugin = createBundlerPlugin()
  plugin.apply(dev as any)
  expect(await (dev.options.entry as any)()).toEqual({ main: { import: ['./dynamic'], filename: 'dynamic.js' } })
  ;(dev as any)[SESSION].active = true
  // activate through the supported API, using an EventEmitter server
  const { EventEmitter } = await import('node:events')
  const middlewares = [{ name: 'existing' }]
  plugin.setupMiddlewares(middlewares, { compiler: dev, server: new EventEmitter(), options: { server: 'http' } })
  const result = await (dev.options.entry as any)()
  expect(result.main.filename).toBe('dynamic.js')
  expect(result.main.import[0]).toContain('domino-bootstrap.cjs')
  expect(result.main.import[1]).toBe('./dynamic')
  expect(middlewares.at(-1)).toEqual({ name: 'existing' })
  await dev.hooks.shutdown.tapPromise.mock.calls[0][1]()
})
test('CJS-loader bridge uses the compiler instance and forwards maps/warnings', async () => {
  const transformedMap = { version: 3, sources: ['src/App.tsx'] }
  const transform = vi.fn().mockResolvedValue({ code: 'instrumented', map: { toString: () => JSON.stringify(transformedMap) } })
  const compiler = { [SESSION]: { active: true, runtimeEntry: '/runtime', session: { transform } } }
  const callback = vi.fn()
  const context = { _compiler: compiler, resourcePath: '/root/src/App.tsx', cacheable: vi.fn(), emitWarning: vi.fn(), async: () => callback }
  instrumentLoader.call(context, 'source', undefined)
  await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(null, 'instrumented', transformedMap))
  expect(context.cacheable).toHaveBeenCalledWith(false)
  expect(transform).toHaveBeenCalledWith('source', context.resourcePath, '/runtime', expect.any(Function), 'esm')
  const inactive = { ...context, _compiler: {} }
  callback.mockClear()
  instrumentLoader.call(inactive, 'original', transformedMap)
  expect(callback).toHaveBeenCalledWith(null, 'original', transformedMap)
})
test('bootstrap only emits browser config and escapes script-sensitive strings', () => {
  const context = { _compiler: { [SESSION]: { active: true, runtimeEntry: '/runtime', session: { runtimeConfig: () => ({ shortcuts: ['</script>'], token: 'token', wsPath: '/preview/__domino/ws' }) } } }, cacheable: vi.fn() }
  const result = bootstrapLoader.call(context as any)
  expect(result).not.toContain('</script>')
  expect(result).toContain('DOMContentLoaded')
  expect(result).not.toContain('agent')
})
