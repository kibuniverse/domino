import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, test } from 'vitest'
import { WebSocket } from 'ws'

import { DeploymentBuild, ManifestStore, parseManifest } from '../src/integration/deployment'
import { normalizeOptions } from '../src/integration/options'
import { DominoSession } from '../src/integration/session'
import { startDominoService } from '../src/service/index'

const roots: string[] = []
const services: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const origin = 'https://app.example.com'
const agent = {
  id: 'test',
  check: async () => ({ ready: true, message: '测试 Agent' }),
  run: async ({ workspaceRoot }: any) => {
    const path = join(workspaceRoot, 'src/App.tsx')
    await writeFile(path, (await readFile(path, 'utf8')).replace('保存', '更新'))
  },
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'domino-service-')))
  roots.push(root)
  await mkdir(join(root, 'src'))
  const path = join(root, 'src/App.tsx')
  const code = 'export const App = () => <button>保存</button>'
  await writeFile(path, code)
  const build = new DeploymentBuild(
    root,
    '/',
    normalizeOptions({ deployment: { enabled: true, projectId: 'test-app' } }),
  )
  const result = await build.transform(code, path, 'runtime', () => {})
  await build.writeManifest(join(root, 'dist'))
  const options = {
    root,
    projectId: 'test-app',
    manifest: '.domino/builds/test-app/latest.json',
    port: 0,
    allowedOrigins: [origin],
    agent,
  }
  const service = await startDominoService(options)
  services.push(service)
  const url = `http://127.0.0.1:${(service.server.address() as any).port}/__domino/v1/`
  const post = (route: string, body: unknown, from = origin) =>
    fetch(url + route, {
      method: 'POST',
      headers: { Origin: from, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  const pair = await (
    await post('pair', { projectId: 'test-app', code: service.pairingCode })
  ).json()
  const hello = {
    protocolVersion: 1,
    token: pair.token,
    sessionId: pair.sessionId,
    projectId: 'test-app',
    buildId: build.buildId,
  }
  const context = {
    sourceId: result!.records[0].sourceId,
    instruction: '修改文字',
    scope: 'auto',
    locator: 'exact',
    route: '/',
    element: {
      tagName: 'button',
      text: '保存',
      rect: { x: 0, y: 0, width: 10, height: 10 },
      styles: {},
    },
  }
  return { root, path, build, service, url, post, hello, context, options }
}
test('standalone service authenticates exact origins, projects, builds, and sessions without leaking its credential', async () => {
  const { post, hello, service, url } = await fixture()
  expect((await post('session', { hello }, 'https://evil.example')).status).toBe(403)
  expect((await post('session', { hello: { ...hello, token: 'bad' } })).status).toBe(401)
  expect((await post('session', { hello: { ...hello, projectId: 'other' } })).status).toBe(409)
  expect((await post('session', { hello: { ...hello, buildId: 'unknown-build' } })).status).toBe(
    409,
  )
  expect((await post('session', { hello: { ...hello, sessionId: 'old-session' } })).status).toBe(
    409,
  )
  const ready = await (await post('session', { hello })).json()
  expect(ready).toMatchObject({
    type: 'ready',
    projectId: 'test-app',
    tasks: [],
    diagnostic: { ready: true },
  })
  expect(JSON.stringify(ready)).not.toContain(service.pairingCode)
  expect(JSON.stringify(ready)).not.toContain(hello.token)
  const preflight = await fetch(url + 'command', {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  })
  expect(preflight.status).toBe(204)
  expect(preflight.headers.get('access-control-allow-origin')).toBe(origin)
  const health = await fetch(url + 'health', { headers: { Origin: origin } })
  expect(await health.json()).toEqual({ protocolVersion: 1 })
})
test('HTTP commands recover lost replies, emit incremental snapshots, and reject stale source selections', async () => {
  const { post, hello, context, path } = await fixture()
  const request = { type: 'task.create', requestId: 'create-request-1', context }
  const first = await (await post('command', { hello, request })).json()
  const duplicate = await (await post('command', { hello, request })).json()
  expect(duplicate.taskId).toBe(first.taskId)
  let ready: any
  for (let i = 0; i < 100; i++) {
    ready = await (await post('sync', { hello })).json()
    if (ready.tasks[0]?.status === 'completed') break
    await new Promise((done) => setTimeout(done, 10))
  }
  expect(ready.tasks[0]).toMatchObject({ status: 'completed', applied: true })
  expect(await readFile(path, 'utf8')).toContain('更新')
  const seqs = { [first.taskId]: ready.tasks[0].seq }
  expect(await (await post('sync', { hello, seqs })).json()).toMatchObject({
    tasks: [],
    taskIds: [first.taskId],
  })
  expect(
    await (
      await post('command', { hello, request: { ...request, requestId: 'create-request-2' } })
    ).json(),
  ).toMatchObject({ error: expect.stringContaining('STALE_SELECTION') })
  const undo = { type: 'task.undo', requestId: 'undo-request-1', taskId: first.taskId }
  const undoReply = await (await post('command', { hello, request: undo })).json()
  expect(undoReply.error).toBeUndefined()
  expect(await (await post('command', { hello, request: undo })).json()).toEqual(undoReply)
  expect(await readFile(path, 'utf8')).toContain('保存')
})
test('WebSocket and HTTP share authentication and command deduplication', async () => {
  const { hello, context, post, url } = await fixture()
  const socket = new WebSocket(url.replace('http:', 'ws:') + 'ws', { origin })
  try {
    await new Promise<void>((done) => socket.once('open', done))
    const ready = new Promise((done) =>
      socket.once('message', (message) => done(JSON.parse(message.toString()))),
    )
    socket.send(JSON.stringify({ type: 'hello', ...hello }))
    expect(await ready).toMatchObject({ type: 'ready' })
    const request = { type: 'task.create', requestId: 'shared-request-1', context }
    const reply = new Promise<any>((done) =>
      socket.on('message', (message) => {
        const result = JSON.parse(message.toString())
        if (result.type === 'reply') done(result)
      }),
    )
    socket.send(JSON.stringify(request))
    const wsReply = await reply
    expect(await (await post('command', { hello, request })).json()).toEqual(wsReply)
  } finally {
    socket.terminate()
  }
})
test('manifest reload retains old builds and rejects public output paths and invalid source paths', async () => {
  const { root, build, path, service } = await fixture()
  await expect(build.writeManifest(root)).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
  const store = new ManifestStore(
    build,
    [join(root, '.domino/builds/test-app/latest.json')],
    'test-app',
  )
  await store.reload()
  expect(store.has(build.buildId)).toBe(true)
  const next = new DeploymentBuild(root, '/', build.options)
  const code = (await readFile(path, 'utf8')) + '\n'
  await writeFile(path, code)
  await next.transform(code, path, 'runtime', () => {})
  await next.writeManifest(join(root, 'dist'))
  await store.reload()
  expect(store.has(next.buildId)).toBe(true)
  expect(store.has(build.buildId)).toBe(true)
  const manifest = JSON.parse(
    await readFile(join(root, '.domino/builds/test-app/latest.json'), 'utf8'),
  )
  manifest.records[0].file = '../outside.tsx'
  expect(() => parseManifest(manifest, 'test-app', ['src'])).toThrow()
  await service.close()
})
test('development middleware supports HTTP fallback with its original token and rejects unauthenticated requests', async () => {
  const { root } = await fixture()
  // The standalone service owns the lock until it closes.
  await services.at(-1)!.close()
  const session = new DominoSession(root, '/preview/', normalizeOptions({ agent }))
  await session.initialize()
  const server = createServer((request, response) =>
    session.middleware(request, response, () => response.end('next')),
  )
  session.attach(server, false, console)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  services.push({
    async close() {
      await session.close()
      await new Promise<void>((done) => server.close(() => done()))
    },
  })
  const base = `http://127.0.0.1:${(server.address() as any).port}`
  const request = (token: string) =>
    fetch(base + '/preview/__domino/v1/sync', {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: { protocolVersion: 1, token, sessionId: session.sessionId } }),
    })
  expect((await request('bad')).status).toBe(401)
  expect(await (await request(session.token)).json()).toMatchObject({ type: 'ready' })
})

test('restart invalidates old credentials and restores persisted create request deduplication', async () => {
  const { options, service, hello, context, post } = await fixture()
  const request = { type: 'task.create', requestId: 'durable-request-1', context }
  const first = await (await post('command', { hello, request })).json()
  for (let i = 0; i < 100; i++) {
    const state = await (await post('sync', { hello })).json()
    if (state.tasks[0]?.status === 'completed') break
    await new Promise((done) => setTimeout(done, 10))
  }
  await service.close()
  const next = await startDominoService(options)
  services.push(next)
  const url = `http://127.0.0.1:${(next.server.address() as any).port}/__domino/v1/`
  const send = (route: string, body: unknown) =>
    fetch(url + route, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  expect((await send('session', { hello })).status).toBe(401)
  const credential = await (
    await send('pair', { projectId: 'test-app', code: next.pairingCode })
  ).json()
  const newHello = { ...hello, token: credential.token, sessionId: credential.sessionId }
  expect(
    (await send('session', { hello: { ...newHello, sessionId: hello.sessionId } })).status,
  ).toBe(409)
  const recovered = await (await send('command', { hello: newHello, request })).json()
  expect(recovered.taskId).toBe(first.taskId)
  const state = await (await send('session', { hello: newHello })).json()
  expect(state.tasks).toHaveLength(1)
  expect(state.tasks[0].status).toBe('completed')
})
