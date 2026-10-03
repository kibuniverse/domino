import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { ReactRefreshRspackPlugin } from '@rspack/plugin-react-refresh'
import { domino } from '@kibuniverse/domino/rspack'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('.', import.meta.url))
const dependencies = fileURLToPath(new URL('../../node_modules', import.meta.url))
const provider = process.env.DOMINO_AGENT ?? 'codex'
if (provider !== 'codex' && provider !== 'claude') throw new Error('DOMINO_AGENT must be codex or claude')

export default (_env, argv) => {
  const development = argv.mode !== 'production'
  const plugin = domino({ agent: { provider } })
  return {
    context: root, mode: development ? 'development' : 'production',
    entry: './src/main.tsx', target: 'web',
    output: { path: fileURLToPath(new URL('./dist', import.meta.url)), filename: 'app.js', publicPath: '/' },
    resolve: { extensions: ['.tsx', '.ts', '.jsx', '.js'], modules: [dependencies, 'node_modules'] },
    module: { rules: [
      { test: /\.[jt]sx?$/, exclude: /node_modules/, loader: 'builtin:swc-loader', options: {
        jsc: { parser: { syntax: 'typescript', tsx: true }, transform: { react: { runtime: 'automatic', development, refresh: development } } },
      } },
      { test: /\.css$/, use: [require.resolve('style-loader'), require.resolve('css-loader')] },
    ] },
    plugins: [plugin, ...(development ? [new ReactRefreshRspackPlugin()] : [])],
    devServer: { host: '127.0.0.1', port: 5182, hot: true, open: false, static: { directory: fileURLToPath(new URL('./public', import.meta.url)) }, setupMiddlewares: plugin.setupMiddlewares },
  }
}
