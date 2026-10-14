import { cp, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

import { test, expect } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'

import { domino } from '../../dist/vite.mjs'
import { fixture } from './helpers/bundler'
import { testAgent, choose, verifyEditAndUndo } from './helpers/workflow'

for (const engine of ['vite', 'webpack', 'rspack1', 'rspack2'] as const)
  test(`${engine}: development edits and HMR remain available when only the Domino WebSocket is blocked`, async ({
    page,
  }) => {
    test.setTimeout(60000)
    let close: () => Promise<void>
    let url: string
    if (engine === 'vite') {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'domino-http-dev-')))
      await cp(resolve('tests/e2e/fixtures'), root, { recursive: true })
      const server = await createServer({
        root,
        configFile: false,
        base: '/preview/',
        plugins: [domino({ agent: testAgent }), react()],
        resolve: {
          alias: {
            react: resolve('node_modules/react'),
            'react-dom': resolve('node_modules/react-dom'),
          },
        },
        server: { host: '127.0.0.1', port: 0, fs: { allow: [root, process.cwd()] } },
      })
      await server.listen()
      url = `http://127.0.0.1:${(server.httpServer!.address() as any).port}/preview/`
      close = async () => {
        await server.close()
        await rm(root, { recursive: true, force: true })
      }
    } else {
      const app = await fixture(engine)
      url = app.url
      close = app.close
    }
    try {
      await page.addInitScript(() => {
        const NativeSocket = window.WebSocket
        window.WebSocket = class extends NativeSocket {
          constructor(url: string | URL, protocols?: string | string[]) {
            if (String(url).includes('__domino')) throw new Error('Domino WebSocket blocked')
            super(url, protocols)
          }
        }
      })
      await choose(page, url)
      await expect(page.locator('.connection')).toContainText('HTTP 轮询')
      await verifyEditAndUndo(page)
    } finally {
      await close!()
    }
  })
