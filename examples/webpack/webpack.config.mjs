import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { domino } from '@kibuniverse/domino/webpack'
import ReactRefreshPlugin from '@pmmmwh/react-refresh-webpack-plugin'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('.', import.meta.url))
const dependencies = fileURLToPath(new URL('../../node_modules', import.meta.url))
const provider = process.env.DOMINO_AGENT ?? 'codex'
if (provider !== 'codex' && provider !== 'claude')
  throw new Error('DOMINO_AGENT must be codex or claude')

export default (_env, argv) => {
  const development = argv.mode !== 'production'
  const plugin = domino({ agent: { provider } })
  return {
    context: root,
    mode: development ? 'development' : 'production',
    entry: './src/main.tsx',
    target: 'web',
    output: {
      path: fileURLToPath(new URL('./dist', import.meta.url)),
      filename: 'app.js',
      publicPath: '/',
    },
    resolve: {
      extensions: ['.tsx', '.ts', '.jsx', '.js'],
      modules: [dependencies, 'node_modules'],
    },
    module: {
      rules: [
        {
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
            plugins: development ? [require.resolve('react-refresh/babel')] : [],
          },
        },
        { test: /\.css$/, use: [require.resolve('style-loader'), require.resolve('css-loader')] },
      ],
    },
    plugins: [plugin, ...(development ? [new ReactRefreshPlugin({ overlay: false })] : [])],
    devServer: {
      host: '127.0.0.1',
      port: 5181,
      hot: true,
      static: { directory: fileURLToPath(new URL('./public', import.meta.url)) },
      setupMiddlewares: plugin.setupMiddlewares,
    },
  }
}
