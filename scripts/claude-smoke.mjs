import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ClaudeAdapter } from '../dist/claude.mjs'
import { TaskManager, SourceRegistry } from '../dist/core.mjs'
import { instrument } from '../dist/transform.mjs'

const root = await realpath(await mkdtemp(join(tmpdir(), 'domino-real-claude-')))
let manager
try {
  await mkdir(join(root, 'src'))
  const before = 'export function Button() { return <button>before</button> }\n'
  await writeFile(join(root, 'src/Button.tsx'), before)
  const registry = new SourceRegistry(root)
  const records = instrument(before, 'src/Button.tsx').records
  registry.replace('src/Button.tsx', records)
  manager = new TaskManager({
    root,
    registry,
    agent: new ClaudeAdapter(),
    directories: ['src'],
    timeoutMs: 300000,
    queueLimit: 1,
  })
  await manager.initialize()
  console.log(manager.diagnostic.message)
  assert.equal(manager.diagnostic.ready, true)
  const task = await manager.create('real-claude-smoke-0001', {
    sourceId: records[0].sourceId,
    instruction:
      'Change only the static button text from before to after in src/Button.tsx. Do not change formatting or add files.',
    scope: 'auto',
    locator: 'exact',
    route: '/',
    element: {
      tagName: 'button',
      text: 'before',
      rect: { x: 0, y: 0, width: 50, height: 20 },
      styles: {},
    },
  })
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Smoke test timed out')), 305000)
    manager.on('task', (update) => {
      if (update.id !== task.id) return
      console.log(update.status, update.logs.at(-1) ?? '')
      if (['completed', 'failed', 'cancelled'].includes(update.status)) {
        clearTimeout(timeout)
        resolve(update)
      }
    })
  })
  assert.equal(result.status, 'completed', result.error)
  assert.equal(result.applied, true)
  assert.match(await readFile(join(root, 'src/Button.tsx'), 'utf8'), />after<\/button>/)
  await manager.close()
  await manager.undo(task.id)
  assert.equal(await readFile(join(root, 'src/Button.tsx'), 'utf8'), before)
  console.log('Real Claude SDK edit, candidate validation, apply, diff and undo passed.')
} finally {
  await manager?.close()
  await rm(root, { recursive: true, force: true })
}
