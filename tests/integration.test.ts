import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, test, vi } from 'vitest'

import { protectStorage } from '../src/integration/http'
import { normalizeOptions, validateBase } from '../src/integration/options'
import { DominoSession } from '../src/integration/session'
import { instrument } from '../src/transform/index'

const roots: string[] = []
const sessions: DominoSession[] = []
const agent = {
  id: 'test',
  check: async () => ({ ready: true, message: 'ready' }),
  run: async () => {},
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'domino-integration-')))
  roots.push(root)
  await mkdir(join(root, 'src'))
  const code = 'export const App = () => <button>保存</button>'
  const path = join(root, 'src/App.tsx')
  await writeFile(path, code)
  const session = new DominoSession(root, '/preview/', normalizeOptions({ agent }))
  sessions.push(session)
  return { root, path, code, session }
}
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
test('normalizes shared options once and rejects invalid execution/base settings', () => {
  expect(normalizeOptions({})).toMatchObject({
    directories: ['src', 'public'],
    timeoutMs: 300000,
    queueLimit: 3,
    allowLan: false,
    shortcuts: ['Alt+Space', 'Space'],
  })
  expect(normalizeOptions({ shortcut: [' Space ', 'Space', '', 'Alt+Space'] }).shortcuts).toEqual([
    'Space',
    'Alt+Space',
  ])
  for (const timeoutMs of [NaN, 999, Infinity, 1800001])
    expect(() => normalizeOptions({ execution: { timeoutMs } })).toThrow()
  for (const queueLimit of [0, 1.5, 11])
    expect(() => normalizeOptions({ execution: { queueLimit } })).toThrow()
  for (const base of ['relative/', '//remote/', '/query?/', '/hash#/', '/back\\slash/'])
    expect(() => validateBase(base)).toThrow()
  expect(validateBase('/preview/')).toBe('/preview/')
})
test('all adapters receive identical source IDs and versions with only the runtime import differing', async () => {
  const { path, code, session } = await fixture()
  const warn = vi.fn()
  const vite = await session.transform(code, path, 'virtual:domino/runtime', warn)
  const webpack = await session.transform(code, path, '/package/runtime-webpack.mjs', warn)
  expect(vite!.records).toEqual(webpack!.records)
  expect(vite!.records).toEqual(instrument(code, 'src/App.tsx').records)
  expect(vite!.code).toContain('virtual:domino/runtime')
  expect(webpack!.code).toContain('/package/runtime-webpack.mjs')
  expect(await session.registry.resolve(vite!.records[0].sourceId)).toMatchObject({ code })
  expect(warn).not.toHaveBeenCalled()
})
test('a transformed, removed, or symbolic-link source cannot leave a stale registry entry', async () => {
  const { root, path, code, session } = await fixture()
  const original = await session.transform(code, path, 'runtime', () => {})
  const id = original!.records[0].sourceId
  const warn = vi.fn()
  expect(await session.transform(code + '\n', path, 'runtime', warn)).toBeUndefined()
  expect(warn).toHaveBeenCalledOnce()
  await expect(session.registry.resolve(id)).rejects.toMatchObject({ code: 'STALE_SELECTION' })
  await session.transform(code, path, 'runtime', warn)
  session.remove(path)
  await expect(session.registry.resolve(id)).rejects.toMatchObject({ code: 'STALE_SELECTION' })
  await symlink(path, join(root, 'src/link.tsx'))
  expect(await session.transform(code, join(root, 'src/link.tsx'), 'runtime', warn)).toBeUndefined()
  expect(
    await session.transform(code, join(root, '../outside.tsx'), 'runtime', warn),
  ).toBeUndefined()
})
test('initialization/close are idempotent, failed initialization leaves no lock, and a new session can restart', async () => {
  const { root, session } = await fixture()
  const starting = session.initialize()
  expect(session.initialize()).toBe(starting)
  await starting
  const conflicting = new DominoSession(root, '/', normalizeOptions({ agent }))
  sessions.push(conflicting)
  await expect(conflicting.initialize()).rejects.toMatchObject({ code: 'WORKSPACE_LOCKED' })
  const closing = session.close()
  expect(session.close()).toBe(closing)
  await closing
  const next = new DominoSession(root, '/', normalizeOptions({ agent }))
  sessions.push(next)
  await next.initialize()
  expect(next.sessionId).not.toBe(session.sessionId)
  const invalid = await fixture()
  const server = new EventEmitter()
  invalid.session.attach(server, false, { info() {}, warn() {}, error() {} })
  await writeFile(join(invalid.root, '.domino'), 'invalid storage')
  await expect(invalid.session.initialize()).rejects.toMatchObject({ code: 'INVALID_STORAGE' })
  expect(server.listenerCount('upgrade')).toBe(0)
  expect(server.listenerCount('close')).toBe(0)
  expect(() =>
    invalid.session.attach(server, false, { info() {}, warn() {}, error() {} }),
  ).toThrow()
})
test('attach registers one upgrade handler and close detaches it', async () => {
  const { session } = await fixture()
  const server = new EventEmitter()
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  session.attach(server, false, logger)
  session.attach(server, false, logger)
  expect(server.listenerCount('upgrade')).toBe(1)
  expect(() => session.attach(new EventEmitter(), false, logger)).toThrow()
  await session.close()
  expect(server.listenerCount('upgrade')).toBe(0)
  expect(server.listenerCount('close')).toBe(0)
})
test('storage middleware rejects encoded and Windows-style routes before static serving', () => {
  for (const url of [
    '/.domino/tasks/x',
    '/preview/%2Edomino/tasks/x?raw',
    '/@fs/project/.domino/x',
    '/preview/%2Edomino%5Ctasks%5Cx',
    '/.DOMINO/tasks/x',
    '/%zz',
  ]) {
    const response = { statusCode: 200, end: vi.fn() }
    const next = vi.fn()
    protectStorage({ url } as any, response as any, next)
    expect(next).not.toHaveBeenCalled()
    expect(response.statusCode).toBe(url === '/%zz' ? 400 : 403)
  }
  const next = vi.fn()
  protectStorage({ url: '/src/App.tsx' } as any, {} as any, next)
  expect(next).toHaveBeenCalledOnce()
})

test('CommonJS source modules report versions without introducing ESM syntax', async () => {
  const { root, session } = await fixture()
  const path = join(root, 'src/util.cjs')
  const code = 'module.exports = { value: 42 }'
  await writeFile(path, code)
  const result = await session.transform(code, path, '/runtime-webpack.mjs', () => {}, 'commonjs')
  expect(result!.code).toContain('require("/runtime-webpack.mjs")')
  expect(result!.code).not.toContain('import {')
})
