import { test, expect } from '@playwright/test'
import webpack from 'webpack'
import { rspack } from '@rspack/core'
import { rspack as rspackV1 } from 'rspack-v1'
import { domino as webpackDomino } from '../../dist/webpack.mjs'
import { domino as rspackDomino } from '../../dist/rspack.mjs'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, realpath, readFile, writeFile, access, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const require = createRequire(import.meta.url)
for (const engine of ['webpack', 'rspack1', 'rspack2']) for (const mode of ['development', 'production']) test(`${engine} ${mode} single builds have no Domino markers, runtime or service`, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'domino-build-')))
  let checked = false
  let compiler: any
  try {
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src/App.jsx'), 'export const App = () => <button>保存</button>; console.log(App)')
    const plugin = (engine === 'webpack' ? webpackDomino : rspackDomino)({ agent: { id: 'test', check: async () => { checked = true; return { ready: true, message: 'ready' } }, run: async () => {} } })
    const loader = engine === 'webpack'
      ? { loader: require.resolve('babel-loader'), options: { configFile: false, babelrc: false, presets: [[require.resolve('@babel/preset-react'), { runtime: 'automatic' }]] } }
      : { loader: 'builtin:swc-loader', options: { jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'automatic' } } } } }
    compiler = (engine === 'webpack' ? webpack : engine === 'rspack1' ? rspackV1 : rspack)({
      context: root, target: 'web', mode, entry: './src/App.jsx',
      output: { path: join(root, 'out'), filename: 'app.js' },
      resolve: { alias: { react: resolve('node_modules/react') } },
      module: { rules: [{ test: /\.jsx$/, ...loader }] }, plugins: [plugin],
    } as any)
    const stats: any = await new Promise((resolve, reject) => compiler.run((error: Error, stats: any) => error ? reject(error) : resolve(stats)))
    expect(stats.hasErrors(), stats.toString({ all: false, errors: true })).toBe(false)
    const bundle = await readFile(join(root, 'out/app.js'), 'utf8')
    for (const marker of ['data-va-id', '__domino/ws', 'mountDomino', 'reportVersion']) expect(bundle).not.toContain(marker)
    expect(checked).toBe(false)
    await expect(access(join(root, '.domino'))).rejects.toThrow()
  } finally {
    if (compiler) await new Promise<void>((resolve, reject) => compiler.close((error: Error) => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
