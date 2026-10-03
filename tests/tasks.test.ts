import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { capture } from '../src/core/files'
import { SourceRegistry } from '../src/core/registry'
import { TaskManager } from '../src/core/tasks'
import type { AgentAdapter, VisualContext } from '../src/core/types'
import { instrument, hash } from '../src/transform/index'

const resources: Array<{ root: string; manager: TaskManager }> = []
afterEach(async () => {
  for (const { root, manager } of resources.splice(0)) {
    await manager.close()
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture(run: AgentAdapter['run']) {
  const root = await mkdtemp(join(tmpdir(), 'domino-test-'))
  await mkdir(join(root, 'src'))
  const code = 'export const A = () => <button>已有用户修改</button>\n'
  await writeFile(join(root, 'src/A.tsx'), code)
  const registry = new SourceRegistry(root)
  const source = instrument(code, 'src/A.tsx').records[0]
  registry.replace(source.file, [source])
  const agent: AgentAdapter = {
    id: 'test',
    check: async () => ({ ready: true, message: 'Test adapter' }),
    run,
  }
  const manager = new TaskManager({
    root,
    registry,
    agent,
    directories: ['src'],
    timeoutMs: 5000,
    queueLimit: 3,
  })
  resources.push({ root, manager })
  await manager.initialize()
  const context: VisualContext = {
    sourceId: source.sourceId,
    instruction: '修改文字',
    scope: 'auto',
    locator: 'exact',
    route: '/',
    element: {
      tagName: 'button',
      text: '已有用户修改',
      rect: { x: 0, y: 0, width: 20, height: 20 },
      styles: {},
    },
  }
  return { root, manager, context, registry, code }
}
const finish = async (manager: TaskManager, id: string) => {
  await vi.waitFor(() =>
    expect(['completed', 'failed', 'cancelled']).toContain(
      manager.list().find((task) => task.id === id)?.status,
    ),
  )
  return manager.list().find((task) => task.id === id)!
}

describe('isolated tasks', () => {
  test('preserves dirty source, applies real diff, acknowledges matching version, and restores baseline', async () => {
    const { manager, root, context, code } = await fixture(async (input) => {
      const path = join(input.workspaceRoot, 'src/A.tsx')
      await writeFile(path, (await readFile(path, 'utf8')).replace('已有用户修改', 'Agent 修改'))
    })
    const task = await manager.create('request-0001', context)
    const result = await finish(manager, task.id)
    expect(result.status).toBe('completed')
    expect(result.applied).toBe(true)
    expect(result.changes[0].patch).toContain('-export const A')
    expect(await readFile(join(root, 'src/A.tsx'), 'utf8')).toContain('Agent 修改')
    await manager.pageUpdated(task.id, { 'src/A.tsx': 'invalid' })
    expect(manager.list()[0].pageUpdate).toBe('pending')
    await manager.pageUpdated(task.id, {
      'src/A.tsx': hash(await readFile(join(root, 'src/A.tsx'), 'utf8')),
    })
    expect(manager.list()[0].pageUpdate).toBe('received')
    await vi.waitFor(() => manager.undo(task.id))
    expect(await readFile(join(root, 'src/A.tsx'), 'utf8')).toBe(code)
  })
  test('idempotency prevents concurrent duplicate executions', async () => {
    const run = vi.fn(async () => {})
    const { manager, context } = await fixture(run)
    const [a, b] = await Promise.all([
      manager.create('request-0001', context),
      manager.create('request-0001', context),
    ])
    expect(a.id).toBe(b.id)
    await finish(manager, a.id)
    expect(run).toHaveBeenCalledTimes(1)
    await expect(
      manager.create('request-0001', { ...context, instruction: '不同请求' }),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' })
  })
  test('rechecks stale selections when queued tasks start', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const run = vi.fn(async (input) => {
      await blocked
      await writeFile(
        join(input.workspaceRoot, 'src/A.tsx'),
        'export const A = () => <button>新版本</button>',
      )
    })
    const { manager, context } = await fixture(run)
    const a = await manager.create('request-0001', context)
    const b = await manager.create('request-0002', context)
    release()
    await finish(manager, a.id)
    expect((await finish(manager, b.id)).error).toContain('STALE_SELECTION')
    expect(run).toHaveBeenCalledTimes(1)
  })
  test('never applies invalid syntax or changes outside the source scope', async () => {
    const { manager, root, context, code } = await fixture(async (input) => {
      await writeFile(join(input.workspaceRoot, 'package.json'), '{}')
    })
    const result = await finish(manager, (await manager.create('request-0001', context)).id)
    expect(result.error).toContain('OUTSIDE_WRITE_SCOPE')
    expect(result.applied).toBe(false)
    expect(await readFile(join(root, 'src/A.tsx'), 'utf8')).toBe(code)
  })
  test('detects concurrent user edits during execution and refuses conflicting undo', async () => {
    const { manager, root, context } = await fixture(async (input) => {
      await writeFile(
        join(input.workspaceRoot, 'src/A.tsx'),
        'export const A = () => <button>候选</button>',
      )
      await writeFile(
        join(root, 'src/A.tsx'),
        'export const A = () => <button>用户并发修改</button>',
      )
    })
    const result = await finish(manager, (await manager.create('request-0001', context)).id)
    expect(result.error).toContain('WORKSPACE_CHANGED')
    expect(await readFile(join(root, 'src/A.tsx'), 'utf8')).toContain('用户并发修改')
  })
  test('undo rejects later user edits without overwriting them', async () => {
    const { manager, root, context } = await fixture(async (input) => {
      await writeFile(
        join(input.workspaceRoot, 'src/A.tsx'),
        'export const A = () => <button>候选</button>',
      )
    })
    const task = await manager.create('request-0001', context)
    await finish(manager, task.id)
    await writeFile(join(root, 'src/A.tsx'), 'export const A = () => <button>后来编辑</button>')
    await vi.waitFor(async () => {
      await expect(manager.undo(task.id)).rejects.toMatchObject({ code: 'FILE_CONFLICT' })
    })
    expect(await readFile(join(root, 'src/A.tsx'), 'utf8')).toContain('后来编辑')
  })
  test('cancel stops candidate execution and never applies its partial edit', async () => {
    const { manager, root, context, code } = await fixture(async (input) => {
      await writeFile(
        join(input.workspaceRoot, 'src/A.tsx'),
        'export const A = () => <button>部分修改</button>',
      )
      await new Promise<void>((_, reject) => {
        if (input.signal.aborted) reject(new Error('aborted'))
        else
          input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    })
    const task = await manager.create('request-0001', context)
    await vi.waitFor(() => expect(manager.list()[0].status).toBe('running'))
    await manager.cancel(task.id)
    expect((await finish(manager, task.id)).status).toBe('cancelled')
    expect(await readFile(join(root, 'src/A.tsx'), 'utf8')).toBe(code)
  })
  test('snapshots reject symlinks and stale registry entries', async () => {
    const { root, registry, context } = await fixture(async () => {})
    await symlink(join(root, 'src/A.tsx'), join(root, 'src/link.tsx'))
    await expect(capture(root, ['src'])).rejects.toMatchObject({ code: 'SYMLINK' })
    await writeFile(join(root, 'src/A.tsx'), '<div/>')
    await expect(registry.resolve(context.sourceId)).rejects.toMatchObject({
      code: 'STALE_SELECTION',
    })
  })
  test('new and deleted files are safely reversed, and history survives server restart', async () => {
    const { manager, root, context, registry, code } = await fixture(async (input) => {
      await rm(join(input.workspaceRoot, 'src/A.tsx'))
      await writeFile(join(input.workspaceRoot, 'src/New.tsx'), 'export const B = () => <div/>')
    })
    const task = await manager.create('request-0001', context)
    await finish(manager, task.id)
    await manager.close()
    const restarted = new TaskManager({
      root,
      registry,
      agent: { id: 'test', check: async () => ({ ready: true, message: '' }), run: async () => {} },
      directories: ['src'],
      timeoutMs: 5000,
      queueLimit: 3,
    })
    await restarted.initialize()
    expect(restarted.list()[0].id).toBe(task.id)
    await restarted.undo(task.id)
    expect(await readFile(join(root, 'src/A.tsx'), 'utf8')).toBe(code)
    await expect(readFile(join(root, 'src/New.tsx'))).rejects.toMatchObject({ code: 'ENOENT' })
    await restarted.close()
  })
})
