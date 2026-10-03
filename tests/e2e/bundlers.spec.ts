import { readFile, writeFile, rm, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { test, expect } from '@playwright/test'
import { WebSocket } from 'ws'

import { fixture } from './helpers/bundler'
import type { Engine } from './helpers/bundler'
import { choose, submit, verifyEditAndUndo } from './helpers/workflow'

for (const engine of ['webpack', 'rspack1', 'rspack2'] as Engine[])
  test.describe(engine, () => {
    let app: Awaited<ReturnType<typeof fixture>>
    test.beforeAll(async () => {
      app = await fixture(engine, engine === 'rspack1', { cache: true })
    })
    test.afterAll(async () => {
      await app?.close()
    })
    test('selection → edit → diff → update acknowledgement → undo, with Fast Refresh state preservation', async ({
      page,
    }) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await choose(page, app.url)
      await expect(page.locator('h1')).toHaveAttribute('data-cjs', 'CJS utility loaded')
      await page.locator('.create-button').click()
      await expect(page.locator('.counter')).toHaveText('已点击 1 次')
      await verifyEditAndUndo(page)
      await expect(page.locator('.counter')).toHaveText('已点击 1 次')
      expect(errors).toEqual([])
      expect(await page.locator('[data-domino-host]').count()).toBe(1)
    })
    test('invalid edits and cancellation leave the source unchanged', async ({ page }) => {
      await choose(page, app.url)
      await submit(page, '产生语法错误')
      await expect(page.locator('.task-status')).toHaveText('失败')
      await expect(page.locator('.create-button')).toHaveText('创建作品')
      await page.getByLabel('修改要求').fill('等待取消')
      await page.getByRole('button', { name: '发送' }).click()
      await page.locator('.progress-head').click()
      await expect(page.locator('.task-status')).toHaveText('Agent 执行中')
      await page.getByRole('button', { name: '取消任务' }).click()
      await expect(page.locator('.task-status')).toHaveText('已取消')
    })
    test('multiple tabs share tasks, and compiler errors recover in the panel', async ({
      page,
      context,
    }) => {
      await choose(page, app.url)
      const other = await context.newPage()
      await other.goto(app.url)
      await other.getByRole('button', { name: '打开 domino' }).click()
      await expect(other.locator('.connection')).toContainText('测试 Agent')
      await submit(page, '产生语法错误')
      await other.locator('.progress-head').click()
      await other
        .getByRole('button', { name: '查看任务：产生语法错误', exact: true })
        .first()
        .click()
      await expect(other.locator('.task-status')).toHaveText('失败')
      const file = join(app.root, 'src/App.tsx')
      const original = await readFile(file, 'utf8')
      try {
        await writeFile(file, 'export function (')
        await expect(page.locator('.build-error')).toContainText('编译诊断')
      } finally {
        await writeFile(file, original)
      }
      await expect(page.locator('.build-error')).toBeEmpty()
      await expect(page.locator('.create-button')).toHaveText('创建作品')
      await other.close()
    })
    test('runtime HMR remounts once, restores the draft, and clears the old DOM selection', async ({
      page,
    }) => {
      await choose(page, app.url)
      await page.getByLabel('修改要求').fill('保留热更新草稿')
      await page.evaluate(() => {
        ;(window as any).__oldDominoHost = document.querySelector('[data-domino-host]')
      })
      const file = resolve('dist/runtime-webpack.mjs')
      const original = await readFile(file, 'utf8')
      try {
        await writeFile(file, original + '\n// runtime HMR fixture\n')
        await expect
          .poll(() => page.evaluate(() => (window as any).__oldDominoHost?.isConnected))
          .toBe(false)
        await expect(page.getByLabel('修改要求')).toHaveValue('保留热更新草稿')
        await expect(page.locator('[data-domino-host]')).toHaveCount(1)
        await expect(page.locator('.target-chip')).toBeHidden()
      } finally {
        await writeFile(file, original)
        await new Promise<void>((resolve) => app.server.invalidate(resolve))
      }
    })
    test('existing middleware, storage protection, authentication, and HMR websocket coexist', async ({
      request,
    }) => {
      expect(await (await request.get(app.url + 'existing')).text()).toBe('preserved')
      const journal = join(app.root, '.domino/tasks/http-test.json')
      await writeFile(journal, '{"private":"source"}')
      try {
        for (const path of [
          '.domino/tasks/http-test.json',
          'preview/%2Edomino/tasks/http-test.json',
          'preview/%2Edomino%5Ctasks%5Chttp-test.json',
        ])
          expect((await request.get(app.url + path)).status()).toBe(403)
      } finally {
        await rm(journal)
      }
      const endpoint = app.url.replace('http', 'ws') + 'preview/__domino/ws'
      const hostile = new WebSocket(endpoint, { origin: 'http://evil.example' })
      hostile.on('error', () => {})
      const status = await new Promise<number>((resolve) =>
        hostile.on('unexpected-response', (_, response) => {
          resolve(response.statusCode!)
          response.resume()
          hostile.terminate()
        }),
      )
      expect(status).toBe(403)
      const unauthenticated = new WebSocket(endpoint, { origin: new URL(app.url).origin })
      unauthenticated.on('error', () => {})
      const code = await new Promise<number>((resolve) => {
        unauthenticated.on('open', () =>
          unauthenticated.send(JSON.stringify({ type: 'task.create' })),
        )
        unauthenticated.on('close', resolve)
      })
      expect(code).toBe(1008)
      const hmr = new WebSocket(app.url.replace('http', 'ws') + 'ws', {
        origin: new URL(app.url).origin,
      })
      hmr.on('error', () => {})
      const payload = await new Promise<string>((resolve) =>
        hmr.once('message', (data) => {
          resolve(data.toString())
          hmr.close()
        }),
      )
      expect(JSON.parse(payload)).toHaveProperty('type')
    })
    test('shutdown releases the workspace lock and a fresh compiler restores registration', async ({
      page,
    }) => {
      const root = app.root
      await app.close(false)
      await expect
        .poll(async () => {
          try {
            await access(join(root, '.domino/lock'))
            return true
          } catch {
            return false
          }
        })
        .toBe(false)
      app = await fixture(engine, true, {
        root,
        cache: true,
        entry: async () => ({
          app: { import: ['./src/main.tsx'], filename: 'app.js' },
          second: { import: ['./src/main.tsx'], filename: 'second.js' },
        }),
      })
      await choose(page, app.url)
      await verifyEditAndUndo(page)
      await page.goto(app.url + 'preview/second.js')
      expect(await page.locator('body').textContent()).toContain('mountDomino')
    })
  })
