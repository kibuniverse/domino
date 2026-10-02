import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { chromium, expect } from '@playwright/test'

// Run against the independently installed React project and its real SDK adapter.
const root = resolve(process.argv[2] ?? '../domino-react-app')
const url = process.argv[3] ?? 'http://127.0.0.1:5180/'
const provider = process.argv[4] ?? 'codex'
assert.ok(['codex', 'claude'].includes(provider), 'Provider must be codex or claude')
const sources = async (directory = join(root, 'src')) => {
  const result = {}
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) Object.assign(result, await sources(path))
    else result[path] = await readFile(path, 'utf8')
  }
  return result
}
const before = await sources()
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  let lastProgress = ''
  page.on('websocket', socket => socket.on('framereceived', frame => {
    try {
      const value = JSON.parse(String(frame.payload))
      if (value.type !== 'task.snapshot') return
      const progress = `${value.task.status}: ${value.task.logs.at(-1) ?? value.task.error ?? ''}`
      if (progress !== lastProgress) { lastProgress = progress; console.log(progress.slice(0, 250)) }
    } catch { /* Vite also uses a separate websocket. */ }
  }))
  await page.goto(url)
  await expect(page.locator('.project-card')).toHaveCount(3)
  await page.getByLabel('搜索项目').fill('品牌')
  await expect(page.locator('.project-card')).toHaveCount(1)
  await page.getByLabel('搜索项目').fill('')
  await page.getByRole('button', { name: '内容', exact: true }).click()
  await expect(page.locator('.project-card')).toHaveCount(1)
  await page.getByRole('button', { name: '全部项目', exact: true }).click()
  const todo = page.locator('.todo-row input').first()
  await todo.check()
  await expect(todo).toBeChecked()
  await todo.uncheck()
  await page.locator('.new-project').click()
  await page.getByLabel('项目名称').fill('接入验证项目')
  await page.getByRole('button', { name: '开始创建' }).click()
  await expect(page.locator('.project-card')).toHaveCount(4)
  await page.locator('.nav-item').filter({ hasText: '工作台' }).click()
  await page.screenshot({ path: '/private/tmp/domino-react-app.png', fullPage: true })
  await page.getByRole('button', { name: '打开 domino' }).click()
  await expect(page.locator('.connection')).toContainText(provider === 'claude' ? 'Claude Agent SDK' : 'Codex SDK')
  await page.getByRole('button', { name: '选择/切换元素' }).click()
  await page.locator('.new-project').click()
  await expect(page.getByRole('dialog', { name: '创建新项目' })).toHaveCount(0)
  await expect(page.locator('.target')).toContainText('button')
  await page.getByLabel('修改要求').fill('将所选按钮文案从“新建项目”改为“创建项目”。只修改 src/App.tsx 中这一段静态文字，保留所有格式和其他代码，不添加文件。')
  await page.getByRole('button', { name: '发送' }).click()
  await page.locator('.progress-head').click()
  await expect(page.locator('.task-status')).toHaveText('Agent 执行中', { timeout: 15000 })
  await page.waitForFunction(() => {
    const status = document.querySelector('[data-domino-host]')?.shadowRoot?.querySelector('.task-status')?.textContent
    return ['已完成', '失败', '已取消'].includes(status ?? '')
  }, undefined, { timeout: 310000 })
  const taskError = await page.locator('.task-error').textContent()
  assert.equal(await page.locator('.task-status').textContent(), '已完成', taskError ?? 'Task failed')
  await expect(page.locator('.new-project')).toContainText('创建项目')
  await expect(page.locator('.page')).toContainText('已收到浏览器模块更新确认')
  await expect(page.locator('.project-card')).toHaveCount(4)
  assert.notEqual(await readFile(join(root, 'src/App.tsx'), 'utf8'), before[join(root, 'src/App.tsx')])
  await page.locator('summary').filter({ hasText: 'src/App.tsx' }).click()
  await expect(page.locator('.diff')).toContainText('创建项目')
  await page.screenshot({ path: '/private/tmp/domino-react-sdk-result.png', fullPage: true })
  await page.getByRole('button', { name: '撤销改动' }).click()
  await expect(page.locator('.task-status')).toHaveText('已撤销')
  await expect(page.locator('.new-project')).toContainText('新建项目')
  assert.deepEqual(await sources(), before, 'Undo must restore every original source file')
  assert.deepEqual(errors, [], 'The actual React page must have no browser runtime errors')
  console.log(`Independent React app: business interactions, real ${provider} SDK edit, diff, HMR, retained React state and undo passed.`)
} finally { await browser.close() }
