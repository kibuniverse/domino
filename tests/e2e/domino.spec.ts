import { mkdtemp, cp, readFile, writeFile, rm, readdir, realpath } from 'node:fs/promises'
import { networkInterfaces, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { test, expect } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer, build } from 'vite'
import type { ViteDevServer } from 'vite'
import { WebSocket } from 'ws'

import { domino } from '../../dist/vite.mjs'

let root: string
let server: ViteDevServer
let url: string
import {
  testAgent as adapter,
  choose as chooseTarget,
  submit,
  verifyEditAndUndo,
} from './helpers/workflow'
test.beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'domino-browser-')))
  // Use fixed fixtures: the interactive example can contain real user edits.
  await cp(resolve('tests/e2e/fixtures'), root, { recursive: true })
  // React is resolved from this project's installed dependencies; no links enter editable dirs.
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
    plugins: [domino({ agent: adapter }), react()],
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root, process.cwd()] } },
  })
  await server.listen()
  const address = server.httpServer!.address() as import('node:net').AddressInfo
  url = `http://127.0.0.1:${address.port}/preview/`
})
test.afterAll(async () => {
  await server?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

const choose = (page: import('@playwright/test').Page) => chooseTarget(page, url)
test('selection → source edit → diff → HMR → conditional undo', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await choose(page)
  await verifyEditAndUndo(page)
  expect(errors).toEqual([])
})
test('invalid candidate remains a visible diff and never changes the original page', async ({
  page,
}) => {
  await choose(page)
  await submit(page, '产生语法错误')
  await expect(page.locator('.task-status')).toHaveText('失败')
  await expect(page.locator('.task-error')).not.toHaveText('')
  await expect(page.locator('.build-error')).toBeEmpty()
  await expect(page.locator('.create-button')).toHaveText('创建作品')
  await expect(page.getByRole('button', { name: '撤销改动' })).toBeDisabled()
})
test('cancel stops the agent and leaves the original page intact', async ({ page }) => {
  await choose(page)
  await submit(page, '等待取消')
  await expect(page.locator('.task-status')).toHaveText('Agent 执行中')
  await page.getByRole('button', { name: '取消任务' }).click()
  await expect(page.locator('.task-status')).toHaveText('已取消')
  await expect(page.locator('.create-button')).toHaveText('创建作品')
})
test('Space and Alt+Space open the editor directly', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(url)
  await page.keyboard.press('Space')
  await expect(page.getByLabel('修改要求')).toBeVisible()
  await expect(page.getByLabel('修改要求')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByLabel('修改要求')).toBeHidden()
  await page.keyboard.press('Alt+Space')
  await expect(page.getByLabel('修改要求')).toBeFocused()
  expect(errors).toEqual([])
})
for (const shortcut of ['Space', 'Alt+Space']) {
  test(`${shortcut} selects the hovered element and keeps it fixed while typing`, async ({
    page,
  }) => {
    await page.goto(url)
    const button = page.locator('.create-button')
    await button.hover()
    await page.keyboard.press(shortcut)
    await expect(page.locator('.target-chip')).toHaveText('button')
    await expect(page.locator('.target-text')).toContainText('创建作品')
    await expect(page.getByLabel('修改要求')).toBeFocused()
    await expect(page.locator('.counter')).toHaveText('已点击 0 次')
    await expect(page.locator('.connection')).toContainText('测试 Agent')
    await page.getByLabel('修改要求').fill('修改当前按钮')
    await expect(page.getByRole('button', { name: '发送' })).toBeEnabled()
    await page.locator('.counter').hover()
    await expect(page.locator('.target-chip')).toHaveText('button')
    await expect(page.locator('.target-text')).toContainText('创建作品')

    await page.keyboard.press('Escape')
    await page.locator('h1').hover()
    await page.keyboard.press(shortcut)
    await expect(page.locator('.target-chip')).toHaveText('h1')
    await expect(page.locator('.target-text')).toContainText('domino 浏览器测试')
    await expect(page.getByLabel('修改要求')).toBeFocused()
  })
}
test('opening from the dock uses the last hovered page element', async ({ page }) => {
  await page.goto(url)
  await page.locator('.create-button').hover()
  await page.getByRole('button', { name: '打开 domino' }).click()
  await expect(page.locator('.target-chip')).toHaveText('button')
  await expect(page.locator('.target-text')).toContainText('创建作品')
  await expect(page.getByLabel('修改要求')).toBeFocused()
})
test('the shortcut fixes the hovered target during manual picking', async ({ page }) => {
  await page.goto(url)
  await page.getByRole('button', { name: '打开 domino' }).click()
  await page.getByRole('button', { name: '选择/切换元素' }).click()
  await page.locator('.create-button').hover()
  await page.keyboard.press('Space')
  await expect(page.locator('.target-chip')).toHaveText('button')
  await expect(page.locator('.target-text')).toContainText('创建作品')
  await expect(page.getByRole('button', { name: '选择/切换元素' })).toBeVisible()
  await expect(page.getByLabel('修改要求')).toBeFocused()
  await expect(page.locator('.counter')).toHaveText('已点击 0 次')
})
test('hover selection resolves an unmarked child to its source-marked ancestor', async ({
  page,
}) => {
  await page.goto(url)
  await page.locator('.create-button').evaluate((button) => {
    const child = document.createElement('span')
    child.textContent = button.textContent
    button.replaceChildren(child)
  })
  await page.locator('.create-button span').hover()
  await page.keyboard.press('Space')
  await expect(page.locator('.target-chip')).toHaveText('button')
  await expect(page.locator('.target-text')).toContainText('定位到带标记的父元素')
  await expect(page.locator('.connection')).toContainText('测试 Agent')
  await page.getByLabel('修改要求').fill('修改父元素')
  await expect(page.getByRole('button', { name: '发送' })).toBeEnabled()
})
test('hover selection resolves the current DOM at the pointer after replacement', async ({
  page,
}) => {
  await page.goto(url)
  await page.locator('.create-button').hover()
  await page.locator('.create-button').evaluate((button) => {
    const replacement = button.cloneNode(true) as HTMLElement
    replacement.textContent = '替换后的按钮'
    button.replaceWith(replacement)
  })
  await page.keyboard.press('Space')
  await expect(page.locator('.target-chip')).toHaveText('button')
  await expect(page.locator('.target-text')).toContainText('替换后的按钮')
  await expect(page.locator('.connection')).toContainText('测试 Agent')
  await page.getByLabel('修改要求').fill('修改新元素')
  await expect(page.getByRole('button', { name: '发送' })).toBeEnabled()
})
test('hovering empty page space does not select the document or domino UI', async ({ page }) => {
  await page.goto(url)
  await page.mouse.move(1200, 500)
  await page.keyboard.press('Space')
  await expect(page.locator('.target-chip')).toBeHidden()
  await expect(page.getByLabel('修改要求')).toBeFocused()
  await page.getByLabel('修改要求').fill('尚未选择元素')
  await expect(page.getByRole('button', { name: '发送' })).toBeDisabled()
  await page.getByRole('button', { name: '关闭面板' }).click()
  await page.getByRole('button', { name: '打开 domino' }).click()
  await expect(page.locator('.target-chip')).toBeHidden()
})
test('rejects cross-origin websocket connections and unauthenticated tasks', async () => {
  const endpoint = url.replace('http', 'ws') + '__domino/ws'
  const hostile = new WebSocket(endpoint, { origin: 'http://evil.example' })
  const status = await new Promise<number>((resolve) => {
    hostile.on('unexpected-response', (_, response) => {
      resolve(response.statusCode!)
      response.resume()
      hostile.terminate()
    })
    hostile.on('error', () => {})
  })
  expect(status).toBe(403)
  const unauthenticated = new WebSocket(endpoint, { origin: new URL(url).origin })
  unauthenticated.on('error', () => {})
  const code = await new Promise<number>((resolve) => {
    unauthenticated.on('open', () =>
      unauthenticated.send(JSON.stringify({ type: 'task.create', requestId: 'malicious-0001' })),
    )
    unauthenticated.on('close', resolve)
  })
  expect(code).toBe(1008)
})
test('task journals cannot be retrieved through Vite file handlers', async ({ request }) => {
  const journal = 'http-deny-test.json'
  const file = join(root, '.domino/tasks', journal)
  await writeFile(file, JSON.stringify({ before: 'private source' }))
  const paths = [
    `.domino/tasks/${journal}`,
    `%2Edomino/tasks/${journal}?raw`,
    `@fs/${root}/.domino/tasks/${journal}?import`,
  ]
  try {
    for (const path of paths) {
      const response = await request.get(url + path)
      expect(response.status()).toBe(403)
      expect(await response.text()).toBe('Forbidden')
    }
  } finally {
    await rm(file)
  }
})
test('production bundles contain no source markers, runtime, or task transport', async () => {
  await build({
    root,
    configFile: false,
    resolve: {
      alias: {
        react: resolve('node_modules/react'),
        'react-dom': resolve('node_modules/react-dom'),
      },
    },
    plugins: [domino({ agent: adapter }), react()],
    build: { outDir: join(root, 'production') },
    logLevel: 'error',
  })
  const assets = await readdir(join(root, 'production/assets'))
  const bundle = (
    await Promise.all(
      assets
        .filter((file) => file.endsWith('.js'))
        .map((file) => readFile(join(root, 'production/assets', file), 'utf8')),
    )
  ).join('\n')
  expect(bundle).not.toContain('data-va-id')
  expect(bundle).not.toContain('__domino/ws')
  expect(bundle).not.toContain('mountDomino')
})
test.describe('LAN access from a non-secure origin', () => {
  let lanRoot: string
  let lanServer: ViteDevServer | undefined
  let lanUrl = ''
  test.beforeAll(async () => {
    const address = Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address
    if (!address) return
    lanRoot = await realpath(await mkdtemp(join(tmpdir(), 'domino-lan-')))
    await cp(resolve('tests/e2e/fixtures'), lanRoot, { recursive: true })
    lanServer = await createServer({
      root: lanRoot,
      configFile: false,
      resolve: {
        alias: {
          react: resolve('node_modules/react'),
          'react-dom': resolve('node_modules/react-dom'),
        },
      },
      plugins: [domino({ agent: adapter, allowLan: true }), react()],
      server: { host: address, port: 0, fs: { allow: [lanRoot, process.cwd()] } },
    })
    await lanServer.listen()
    lanUrl = `http://${address}:${(lanServer.httpServer!.address() as import('node:net').AddressInfo).port}/`
  })
  test.afterAll(async () => {
    await lanServer?.close()
    if (lanRoot) await rm(lanRoot, { recursive: true, force: true })
  })
  test('HTTP over a LAN address has no crypto.randomUUID and still submits', async ({ page }) => {
    test.skip(!lanUrl, 'no non-internal IPv4 address available')
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(lanUrl)
    expect(
      await page.evaluate(() => ({
        secure: window.isSecureContext,
        randomUUID: typeof crypto.randomUUID,
        getRandomValues: typeof crypto.getRandomValues,
      })),
    ).toEqual({ secure: false, randomUUID: 'undefined', getRandomValues: 'function' })
    await page.getByRole('button', { name: '打开 domino' }).click()
    await expect(page.locator('.connection')).toContainText('测试 Agent')
    await page.getByRole('button', { name: '选择/切换元素' }).click()
    await page.locator('.create-button').click()
    await page.getByLabel('修改要求').fill('修改按钮文字和颜色')
    await page.getByRole('button', { name: '发送' }).click()
    await expect(page.locator('.task-status')).toHaveText('已完成')
    expect(errors).toEqual([])
  })
})
