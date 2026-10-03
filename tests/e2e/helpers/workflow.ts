import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'

export const testAgent = {
  id: 'test',
  check: async () => ({ ready: true, message: '测试 Agent · 隔离副本' }),
  run: async (input: any) => {
    if (input.prompt.includes('等待取消')) {
      await new Promise((_, reject) =>
        input.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
          once: true,
        }),
      )
      return
    }
    if (input.prompt.includes('产生语法错误')) {
      await writeFile(join(input.workspaceRoot, 'src/main.tsx'), 'export function (')
      return
    }
    const main = join(input.workspaceRoot, 'src/App.tsx')
    const style = join(input.workspaceRoot, 'src/style.css')
    await writeFile(
      main,
      (await readFile(main, 'utf8')).replace('>创建作品</button>', '>紫色创建</button>'),
    )
    await writeFile(
      style,
      (await readFile(style, 'utf8')).replace(
        'background: #27252f; color: white',
        'background: #805cf5; color: white',
      ),
    )
    input.emit({ type: 'message', text: '已修改按钮文字和颜色。' })
  },
}
export async function choose(page: Page, url: string) {
  await page.goto(url)
  await page.getByRole('button', { name: '打开 domino' }).click()
  await expect(page.locator('.connection')).toContainText('测试 Agent')
  await page.getByRole('button', { name: '选择/切换元素' }).click()
  await page.locator('.create-button').click()
  await expect(page.locator('.counter')).toHaveText('已点击 0 次')
}
export async function submit(page: Page, instruction: string) {
  await page.getByLabel('修改要求').fill(instruction)
  await page.getByRole('button', { name: '发送' }).click()
  await page.locator('.progress-head').click()
}
export async function verifyEditAndUndo(page: Page) {
  await submit(page, '修改按钮文字和颜色')
  await expect(page.locator('.task-status')).toHaveText('已完成')
  await expect(page.locator('.create-button')).toHaveText('紫色创建')
  await expect(page.locator('.create-button')).toHaveCSS('background-color', 'rgb(128, 92, 245)')
  await expect(page.locator('.page')).toContainText('已收到浏览器模块更新确认')
  await page.locator('summary').filter({ hasText: 'src/App.tsx' }).click()
  await expect(page.locator('.diff').first()).toContainText('紫色创建')
  await page.getByRole('button', { name: '撤销改动' }).click()
  await expect(page.locator('.task-status')).toHaveText('已撤销')
  await expect(page.locator('.create-button')).toHaveText('创建作品')
}
