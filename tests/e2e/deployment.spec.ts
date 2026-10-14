import { cp, mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { test, expect } from '@playwright/test'
import { rspack } from '@rspack/core'
import react from '@vitejs/plugin-react'
import { rspack as rspackV1 } from 'rspack-v1'
import { build as viteBuild } from 'vite'
import webpack from 'webpack'

import { domino as rspackDomino } from '../../dist/rspack.mjs'
import { startDominoService } from '../../dist/service.mjs'
import { domino as viteDomino } from '../../dist/vite.mjs'
import { domino as webpackDomino } from '../../dist/webpack.mjs'
import { testAgent, submit } from './helpers/workflow'

const require = createRequire(import.meta.url)
for (const engine of ['vite', 'webpack', 'rspack1', 'rspack2'])
  test(`${engine}: static deployment pairs with a standalone service, edits over HTTP, rebuilds and undoes`, async ({
    page,
  }) => {
    test.setTimeout(120000)
    const root = await realpath(await mkdtemp(join(tmpdir(), `domino-deployed-${engine}-`)))
    let service: Awaited<ReturnType<typeof startDominoService>> | undefined
    let staticServer: ReturnType<typeof createServer> | undefined
    try {
      await cp(resolve('tests/e2e/fixtures'), root, { recursive: true })
      const original = await readFile(join(root, 'src/App.tsx'), 'utf8')
      const originalStyle = await readFile(join(root, 'src/style.css'), 'utf8')
      const bundle = async () => {
        const deployment = { enabled: true, projectId: 'test-app' }
        const aliases = {
          react: resolve('node_modules/react'),
          'react-dom': resolve('node_modules/react-dom'),
        }
        if (engine === 'vite') {
          const previousEnvironment = process.env.NODE_ENV
          try {
            await viteBuild({
              root,
              configFile: false,
              logLevel: 'error',
              plugins: [
                viteDomino({
                  deployment,
                  agent: {
                    id: 'forbidden',
                    check: async () => {
                      throw new Error('build must not start Agent')
                    },
                    run: async () => {},
                  },
                }),
                react(),
              ],
              resolve: { alias: aliases },
              build: { outDir: join(root, 'dist') },
            })
          } finally {
            if (previousEnvironment === undefined) delete process.env.NODE_ENV
            else process.env.NODE_ENV = previousEnvironment
          }
        } else {
          const factory = engine === 'webpack' ? webpack : engine === 'rspack1' ? rspackV1 : rspack
          const loader =
            engine === 'webpack'
              ? {
                  loader: require.resolve('babel-loader'),
                  options: {
                    babelrc: false,
                    configFile: false,
                    presets: [
                      [require.resolve('@babel/preset-react'), { runtime: 'automatic' }],
                      require.resolve('@babel/preset-typescript'),
                    ],
                  },
                }
              : {
                  loader: 'builtin:swc-loader',
                  options: {
                    jsc: {
                      parser: { syntax: 'typescript', tsx: true },
                      transform: { react: { runtime: 'automatic' } },
                      target: 'es2022',
                    },
                  },
                }
          const compiler: any = factory({
            context: root,
            mode: 'production',
            target: 'web',
            entry: './src/main.tsx',
            output: { path: join(root, 'dist'), filename: 'app.js' },
            resolve: {
              alias: aliases,
              extensions: ['.tsx', '.ts', '.js'],
              modules: [resolve('node_modules'), 'node_modules'],
            },
            module: {
              rules: [
                { test: /\.[jt]sx?$/, exclude: /node_modules/, ...loader },
                {
                  test: /\.css$/,
                  use: [require.resolve('style-loader'), require.resolve('css-loader')],
                },
              ],
            },
            plugins: [(engine === 'webpack' ? webpackDomino : rspackDomino)({ deployment })],
            infrastructureLogging: { level: 'error' },
            stats: 'errors-only',
          } as any)
          try {
            const stats: any = await new Promise((done, reject) =>
              compiler.run((error: Error, result: any) => (error ? reject(error) : done(result))),
            )
            expect(stats.hasErrors(), stats.toString({ all: false, errors: true })).toBe(false)
          } finally {
            await new Promise<void>((done, reject) =>
              compiler.close((error: Error) => (error ? reject(error) : done())),
            )
          }
          await writeFile(
            join(root, 'dist/index.html'),
            '<!doctype html><meta charset="utf-8"><div id="root"></div><script defer src="/app.js"></script>',
          )
        }
      }
      await bundle()
      const manifest = JSON.parse(
        await readFile(join(root, '.domino/builds/test-app/latest.json'), 'utf8'),
      )
      expect(manifest.records.length).toBeGreaterThan(0)
      expect(manifest).not.toHaveProperty('token')
      const dist = join(root, 'dist')
      staticServer = createServer((request, response) => {
        const path = resolve(
          dist,
          `.${new URL(request.url!, 'http://local').pathname === '/' ? '/index.html' : new URL(request.url!, 'http://local').pathname}`,
        )
        if (!path.startsWith(dist + '/')) {
          response.statusCode = 403
          response.end()
          return
        }
        void readFile(path)
          .then((data) => {
            response.setHeader(
              'Content-Type',
              path.endsWith('.html')
                ? 'text/html'
                : path.endsWith('.css')
                  ? 'text/css'
                  : 'text/javascript',
            )
            response.end(data)
          })
          .catch(() => {
            response.statusCode = 404
            response.end()
          })
      })
      await new Promise<void>((done) => staticServer!.listen(0, '127.0.0.1', done))
      const appUrl = `http://127.0.0.1:${(staticServer.address() as any).port}`
      service = await startDominoService({
        root,
        projectId: 'test-app',
        manifest: '.domino/builds/test-app/latest.json',
        allowedOrigins: [appUrl],
        port: 0,
        agent: testAgent,
      })
      const serviceUrl = `http://127.0.0.1:${(service.server.address() as any).port}`
      await page.addInitScript(() => {
        window.WebSocket = class {
          static OPEN = 1
          constructor() {
            throw new Error('WebSocket blocked')
          }
        } as any
      })
      await page.goto(appUrl)
      await page.getByRole('button', { name: '打开 domino' }).click()
      await expect(page.getByLabel('服务地址')).toBeVisible()
      await page.getByLabel('服务地址').fill(serviceUrl)
      await page.getByRole('button', { name: '测试连接' }).click()
      await expect(page.locator('.notice')).toContainText('服务可达')
      if (engine === 'vite') await page.screenshot({ path: '/tmp/domino-connection-settings.png' })
      await page.getByLabel('配对码').fill(service.pairingCode)
      await page.getByRole('button', { name: '连接', exact: true }).click()
      await expect(page.locator('.connection')).toContainText('HTTP 轮询')
      await page.getByRole('button', { name: '选择/切换元素' }).click()
      await page.locator('.create-button').click()
      await submit(page, '修改按钮文字和颜色')
      await expect(page.locator('.task-status')).toHaveText('已完成', { timeout: 15000 })
      await expect(page.locator('.page')).toContainText('等待重新构建部署')
      await expect(page.locator('.create-button')).toHaveText('创建作品')
      expect(await readFile(join(root, 'src/App.tsx'), 'utf8')).toContain('紫色创建')
      await page.getByRole('button', { name: '选择/切换元素' }).click()
      await page.locator('.create-button').click()
      await submit(page, '继续修改旧页面')
      await expect(page.locator('.notice')).toContainText('STALE_SELECTION')
      await bundle()
      await page.reload()
      await page.getByRole('button', { name: '打开 domino' }).click()
      await expect(page.locator('.create-button')).toHaveText('紫色创建')
      await expect(page.locator('.connection')).toContainText('HTTP 轮询')
      await page.locator('.progress-head').click()
      await expect(page.locator('.page')).toContainText('已收到浏览器模块更新确认', {
        timeout: 15000,
      })
      await page.getByRole('button', { name: '撤销改动' }).click()
      await expect(page.locator('.task-status')).toHaveText('已撤销', { timeout: 15000 })
      await expect(page.locator('.page')).toContainText('源码已撤销')
      expect(await readFile(join(root, 'src/App.tsx'), 'utf8')).toBe(original)
      expect(await readFile(join(root, 'src/style.css'), 'utf8')).toBe(originalStyle)
      expect((await fetch(serviceUrl + '/.domino/tasks/anything')).status).toBe(404)
    } finally {
      await service?.close()
      if (staticServer)
        await new Promise<void>((done) => {
          staticServer!.close(() => done())
          staticServer!.closeAllConnections()
        })
      await rm(root, { recursive: true, force: true })
    }
  })
