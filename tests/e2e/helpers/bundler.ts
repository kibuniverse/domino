import { cp, mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import ReactRefreshWebpackPlugin from '@pmmmwh/react-refresh-webpack-plugin'
import { rspack } from '@rspack/core'
import { RspackDevServer } from '@rspack/dev-server'
import { ReactRefreshRspackPlugin } from '@rspack/plugin-react-refresh'
import { RspackDevServer as RspackDevServerV1 } from 'rspack-dev-server-v1'
import ReactRefreshV1 from 'rspack-refresh-v1'
import { rspack as rspackV1 } from 'rspack-v1'
import webpack from 'webpack'
import WebpackDevServer from 'webpack-dev-server'

import { domino as rspackDomino } from '../../../dist/rspack.mjs'
import { domino as webpackDomino } from '../../../dist/webpack.mjs'
import { testAgent } from './workflow'

const require = createRequire(import.meta.url)
export type Engine = 'webpack' | 'rspack1' | 'rspack2'
export async function fixture(
  engine: Engine,
  cjs = false,
  options: { root?: string; entry?: any; cache?: boolean } = {},
) {
  const root = options.root ?? (await realpath(await mkdtemp(join(tmpdir(), `domino-${engine}-`))))
  if (!options.root) {
    await cp(resolve('tests/e2e/fixtures'), root, { recursive: true })
    await writeFile(join(root, 'src/util.cjs'), 'module.exports = { value: "CJS utility loaded" }')
    const app = join(root, 'src/App.tsx')
    await writeFile(
      app,
      "import { value } from './util.cjs'\n" +
        (await readFile(app, 'utf8')).replace('<h1>', '<h1 data-cjs={value}>'),
    )
  }
  await writeFile(
    join(root, 'index.html'),
    '<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script defer src="/preview/app.js"></script></body></html>',
  )
  const factory = cjs
    ? require(`../../../dist/${engine === 'webpack' ? 'webpack' : 'rspack'}.cjs`).domino
    : engine === 'webpack'
      ? webpackDomino
      : rspackDomino
  const plugin = factory({ agent: testAgent, base: '/preview/' })
  const config: any = {
    context: root,
    mode: 'development',
    target: 'web',
    entry: options.entry ?? { app: './src/main.tsx' },
    cache:
      options.cache && engine === 'webpack'
        ? {
            type: 'filesystem',
            cacheDirectory: join(root, '.cache'),
            buildDependencies: { config: [] },
          }
        : (options.cache ?? false),
    output: { path: join(root, 'dist'), filename: '[name].js', publicPath: '/preview/' },
    resolve: {
      extensions: ['.tsx', '.ts', '.jsx', '.js'],
      alias: {
        react: resolve('node_modules/react'),
        'react-dom': resolve('node_modules/react-dom'),
        ...(engine === 'rspack1'
          ? {
              '@rspack/core': resolve('node_modules/rspack-v1'),
              [dirname(require.resolve('@rspack/core/hot/log.js'))]: dirname(
                require.resolve('rspack-v1/hot/log.js'),
              ),
              '@rspack/dev-server': resolve('node_modules/rspack-dev-server-v1'),
              '@rspack/plugin-react-refresh': resolve('node_modules/rspack-refresh-v1'),
            }
          : {}),
      },
      modules: [resolve('node_modules'), 'node_modules'],
    },
    resolveLoader: { modules: [resolve('node_modules')] },
    module: {
      rules: [
        engine === 'webpack'
          ? {
              test: /\.[jt]sx?$/,
              exclude: /node_modules/,
              loader: require.resolve('babel-loader'),
              options: {
                babelrc: false,
                configFile: false,
                presets: [
                  [require.resolve('@babel/preset-react'), { runtime: 'automatic' }],
                  require.resolve('@babel/preset-typescript'),
                ],
                plugins: [require.resolve('react-refresh/babel')],
              },
            }
          : {
              test: /\.[jt]sx?$/,
              exclude: /node_modules/,
              loader: 'builtin:swc-loader',
              options: {
                jsc: {
                  parser: { syntax: 'typescript', tsx: true },
                  transform: { react: { runtime: 'automatic', development: true, refresh: true } },
                  target: 'es2022',
                },
              },
            },
        { test: /\.css$/, use: [require.resolve('style-loader'), require.resolve('css-loader')] },
      ],
    },
    plugins: [
      plugin,
      engine === 'webpack'
        ? new ReactRefreshWebpackPlugin({ overlay: false })
        : engine === 'rspack1'
          ? new ReactRefreshV1({ overlay: false })
          : new ReactRefreshRspackPlugin(),
    ],
    infrastructureLogging: { level: 'error' },
    stats: 'errors-only',
  }
  const compiler: any = (engine === 'webpack' ? webpack : engine === 'rspack1' ? rspackV1 : rspack)(
    config,
  )
  const DevServer: any =
    engine === 'webpack'
      ? WebpackDevServer
      : engine === 'rspack1'
        ? RspackDevServerV1
        : RspackDevServer
  const server = new DevServer(
    {
      host: '127.0.0.1',
      port: 0,
      hot: true,
      open: false,
      client: { overlay: false, logging: 'error' },
      static: { directory: root, watch: false },
      historyApiFallback: true,
      setupMiddlewares(middlewares: any[], devServer: any) {
        middlewares.unshift({
          name: 'existing',
          path: '/existing',
          middleware: (_req: any, res: any) => res.end('preserved'),
        })
        return plugin.setupMiddlewares(middlewares, devServer)
      },
    },
    compiler,
  )
  try {
    await server.start()
  } catch (error) {
    await server.stop().catch(() => {})
    await rm(root, { recursive: true, force: true })
    throw error
  }
  const url = `http://127.0.0.1:${server.server.address().port}/`
  return {
    root,
    server,
    compiler,
    url,
    async close(remove = true) {
      await server.stop()
      await new Promise<void>((resolve, reject) =>
        compiler.close((error: Error) => (error ? reject(error) : resolve())),
      )
      if (remove) await rm(root, { recursive: true, force: true })
    },
  }
}
