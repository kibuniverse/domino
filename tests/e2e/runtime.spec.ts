import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { test, expect } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import type { ViteDevServer } from 'vite'

import { domino as bundledDomino } from '../../dist/vite.mjs'
import { domino as sourceDomino } from '../../src/vite/index'

for (const mode of ['source', 'bundle'] as const)
  test.describe(`${mode} React runtime`, () => {
    let server: ViteDevServer
    let root: string
    let url: string
    let release: (() => void) | undefined
    test.beforeAll(async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), 'domino-react-runtime-')))
      await cp(resolve('tests/e2e/fixtures'), root, { recursive: true })
      const plugin = mode === 'source' ? sourceDomino : bundledDomino
      server = await createServer({
        root,
        configFile: false,
        base: '/preview/',
        resolve: {
          alias: {
            react: resolve('node_modules/react'),
            'react-dom': resolve('node_modules/react-dom'),
          },
        },
        plugins: [
          plugin({
            agent: {
              id: 'runtime-test',
              check: async () => ({ ready: true, message: 'React runtime 测试 Agent' }),
              run: async (input) => {
                const file = join(input.workspaceRoot, 'src/App.tsx')
                await writeFile(
                  file,
                  (await readFile(file, 'utf8')).replace(
                    '>创建作品</button>',
                    '>React 改造完成</button>',
                  ),
                )
                input.emit({ type: 'message', text: '已生成修改。' })
                if (input.prompt.includes('暂停任务'))
                  await new Promise<void>((resolve, reject) => {
                    release = () => {
                      input.emit({ type: 'message', text: '继续任务。' })
                      resolve()
                    }
                    input.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
                      once: true,
                    })
                  })
              },
            },
          }),
          react(),
        ],
        server: { host: '127.0.0.1', port: 0, fs: { allow: [root, process.cwd()] } },
      })
      await server.listen()
      url = `http://127.0.0.1:${(server.httpServer!.address() as import('node:net').AddressInfo).port}/preview/`
    })
    test.afterAll(async () => {
      release?.()
      await server?.close()
      if (root) await rm(root, { recursive: true, force: true })
    })
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => {
        const NativeWebSocket = window.WebSocket
        ;(window as any).dominoConnections = 0
        ;(window as any).dominoSockets = []
        window.WebSocket = class extends NativeWebSocket {
          send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
            if (typeof data === 'string') {
              try {
                const message = JSON.parse(data)
                if (message.type === 'task.create') (window as any).lastDominoRequest = message
              } catch {
                /* Vite also sends plain-text pings. */
              }
            }
            super.send(data)
          }
          constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols)
            if (String(url).endsWith('/__domino/ws')) {
              ;(window as any).dominoSockets.push(this)
              this.addEventListener('open', () => {
                ;(window as any).dominoConnections++
              })
              this.addEventListener('close', () => {
                ;(window as any).dominoConnections--
              })
              this.addEventListener('message', (event) => {
                const message = JSON.parse(String(event.data))
                if (message.type === 'task.snapshot') (window as any).lastTaskMessage = message
              })
            }
          }
        }
      })
      await page.goto(url)
      await page.locator('.create-button').hover()
      await page.keyboard.press('Space')
      await expect(page.locator('.connection')).toContainText('React runtime 测试 Agent')
    })

    test('Glide Select pointer picks preserve the draft and submit the chosen scope', async ({
      page,
    }, testInfo) => {
      const scope = page.getByRole('combobox', { name: '作用范围' })
      await expect(scope).toHaveText('由 Agent 判断')
      await page.getByLabel('修改要求').fill('修改作用范围测试')
      await scope.click()
      await expect(page.getByRole('listbox', { name: '作用范围' })).toBeVisible()
      await page.getByRole('option', { name: '仅当前使用处（意图）' }).click()
      await expect(scope).toHaveText('仅当前使用处（意图）')
      await expect(scope).toBeFocused()
      await expect(page.getByLabel('修改要求')).toHaveValue('修改作用范围测试')
      await scope.click()
      await page.getByRole('option', { name: '修改共享组件' }).hover()
      await page.screenshot({
        path: testInfo.outputPath(`domino-glide-${mode}.png`),
        fullPage: true,
      })
      await page.getByRole('option', { name: '修改共享组件' }).click()
      await expect(scope).toHaveText('修改共享组件')
      await page.getByRole('button', { name: '发送' }).click()
      await expect(page.locator('.task-status')).toHaveText('已完成')
      expect(await page.evaluate(() => (window as any).lastDominoRequest.context.scope)).toBe(
        'component',
      )
      await page.locator('.progress-head').click()
      await page.getByRole('button', { name: '撤销改动' }).click()
      await expect(page.locator('.create-button')).toHaveText('创建作品')
    })

    test('Glide Select keyboard, outside clicks and narrow-screen menus stay inside the overlay', async ({
      page,
    }) => {
      const scope = page.getByRole('combobox', { name: '作用范围' })
      await scope.focus()
      await page.keyboard.press('Space')
      await expect(scope).toHaveAttribute('aria-expanded', 'true')
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Enter')
      await expect(scope).toHaveText('仅当前使用处（意图）')
      await page.keyboard.press('Enter')
      await page.keyboard.press('End')
      await page.keyboard.press('Enter')
      await expect(scope).toHaveText('修改共享组件')
      expect(await page.evaluate(() => (window as any).lastDominoRequest)).toBeUndefined()
      await page.keyboard.press('Space')
      await page.keyboard.press('Escape')
      await expect(scope).toHaveAttribute('aria-expanded', 'false')
      await expect(page.getByLabel('修改要求')).toBeVisible()
      await page.keyboard.press('Space')
      await page.keyboard.press('Tab')
      await expect(page.getByLabel('修改要求')).toBeFocused()
      await expect(scope).toHaveAttribute('aria-expanded', 'false')
      await scope.click()
      await page.getByLabel('修改要求').click()
      await expect(page.getByRole('listbox', { name: '作用范围' })).toHaveCount(0)
      await page.setViewportSize({ width: 390, height: 700 })
      await scope.click()
      const menu = page.getByRole('listbox', { name: '作用范围' })
      await expect(menu).toBeVisible()
      const box = await menu.boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(390)
      expect(box!.y).toBeGreaterThanOrEqual(0)
      expect(box!.y + box!.height).toBeLessThanOrEqual(700)
      await page.getByRole('option', { name: '由 Agent 判断' }).click()
      await expect(scope).toHaveText('由 Agent 判断')
      await scope.click()
      await page.getByRole('button', { name: '关闭面板' }).click()
      await expect(menu).toHaveCount(0)
      await expect(page.getByLabel('修改要求')).toBeHidden()
    })

    test('task events keep the draft, focus and expanded diff; history navigation stays local', async ({
      page,
    }) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.getByLabel('修改要求').fill('暂停任务并修改按钮')
      await page.getByRole('button', { name: '发送' }).click()
      await expect(page.locator('.task-status')).toHaveText('Agent 执行中')
      await page.locator('.progress-head').click()
      await expect(page.locator('.shiny-text')).toBeVisible()
      await expect(page.locator('.log')).toContainText('已生成修改。')
      await page.getByLabel('修改要求').fill('保留这个草稿')
      await page.keyboard.press('ArrowDown')
      await expect(page.getByLabel('修改要求')).toBeFocused()
      release?.()
      release = undefined
      await expect(page.locator('.task-status')).toHaveText('已完成')
      await expect(page.locator('.page')).toContainText('已收到浏览器模块更新确认')
      await expect(page.getByLabel('修改要求')).toHaveValue('保留这个草稿')
      await expect(page.getByLabel('修改要求')).toBeFocused()
      const details = page.locator('.diffs details').first()
      await details.locator('summary').click()
      await page.evaluate(() => {
        ;(window as any).oldDetails = document
          .querySelector('[data-domino-host]')!
          .shadowRoot!.querySelector('.diffs details')
      })
      await page.getByLabel('修改要求').focus()
      // Feed another transport snapshot to catch DOM recreation during log updates.
      await page.evaluate(() => {
        const message = (window as any).lastTaskMessage
        message.task.seq++
        message.task.logs.push('补充执行日志。')
        ;(window as any).dominoSockets
          .at(-1)
          .dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }))
      })
      await expect(page.locator('.log')).toContainText('补充执行日志。')
      await expect(details).toHaveAttribute('open', '')
      expect(
        await page.evaluate(
          () =>
            (window as any).oldDetails ===
            document
              .querySelector('[data-domino-host]')!
              .shadowRoot!.querySelector('.diffs details'),
        ),
      ).toBe(true)
      await expect(page.getByLabel('修改要求')).toBeFocused()
      await page.locator('.history-list button').last().focus()
      await page.keyboard.press('Tab')
      await expect(page.getByRole('button', { name: '撤销改动' })).toBeFocused()
      await page.getByRole('button', { name: '撤销改动' }).click()
      await expect(page.locator('.create-button')).toHaveText('创建作品')
      expect(errors).toEqual([])
    })

    test('mounting twice and closing the panel keep one connection; pagehide disposes it', async ({
      page,
    }) => {
      await page.evaluate(async () => {
        const runtime = await import(/* @vite-ignore */ '/preview/@id/virtual:domino/runtime')
        runtime.mountDomino({ token: '', sessionId: '', wsPath: '', shortcuts: [] })
      })
      await expect(page.locator('[data-domino-host]')).toHaveCount(1)
      await page.getByRole('button', { name: '关闭面板' }).click()
      await expect.poll(() => page.evaluate(() => (window as any).dominoConnections)).toBe(1)
      await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
      await expect(page.locator('[data-domino-host]')).toHaveCount(0)
      await expect.poll(() => page.evaluate(() => (window as any).dominoConnections)).toBe(0)
    })

    test('reduced motion and a narrow viewport keep the panel usable', async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.setViewportSize({ width: 390, height: 700 })
      await page.reload()
      // Reload restores the open panel, but deliberately drops the DOM selection.
      if (await page.getByRole('button', { name: '关闭面板' }).isVisible())
        await page.getByRole('button', { name: '关闭面板' }).click()
      await page.locator('.create-button').hover()
      await page.keyboard.press('Space')
      await page.getByLabel('修改要求').fill('暂停任务')
      await page.getByRole('button', { name: '发送' }).click()
      await expect(page.locator('.task-status')).toHaveText('Agent 执行中')
      await expect(page.locator('.shiny-text')).toHaveCount(0)
      const panel = await page.locator('.panel').boundingBox()
      expect(panel!.x).toBeGreaterThanOrEqual(0)
      expect(panel!.x + panel!.width).toBeLessThanOrEqual(390)
      await page.locator('.progress-head').click()
      await page.getByRole('button', { name: '取消任务' }).click()
      await expect(page.locator('.task-status')).toHaveText('已取消')
      release = undefined
    })

    if (mode === 'source')
      test('runtime HMR remounts once and restores drafts without keeping DOM selections', async ({
        page,
      }) => {
        const errors: string[] = []
        page.on('pageerror', (error) => errors.push(error.message))
        await page.getByLabel('修改要求').fill('热更新保留草稿')
        await page.evaluate(() => {
          ;(window as any).oldHost = document.querySelector('[data-domino-host]')
        })
        const module = server.moduleGraph.getModuleById(resolve('src/runtime/index.ts'))!
        expect(module).toBeTruthy()
        await server.reloadModule(module)
        await expect
          .poll(() => page.evaluate(() => !(window as any).oldHost.isConnected))
          .toBe(true)
        await expect(page.locator('[data-domino-host]')).toHaveCount(1)
        await expect(page.getByLabel('修改要求')).toHaveValue('热更新保留草稿')
        await expect(page.getByRole('button', { name: '发送' })).toBeDisabled()
        await expect.poll(() => page.evaluate(() => (window as any).dominoConnections)).toBe(1)
        expect(errors).toEqual([])
      })
  })
