import type { IncomingMessage } from 'node:http'

import { expect, test } from 'vitest'

import { parseCreate } from '../src/core/protocol'
import { allowedConnection } from '../src/integration/http'
import { domino } from '../src/vite/index'

test('validates and minimizes browser context', () => {
  const value = {
    requestId: 'request-0001',
    context: {
      sourceId: `s_${'a'.repeat(24)}`,
      instruction: '修改',
      scope: 'auto',
      locator: 'exact',
      route: '/?token=secret',
      file: '/etc/passwd',
      element: {
        tagName: 'button',
        text: '保存',
        rect: { x: 0, y: 0, width: 1, height: 1 },
        styles: { color: 'red', token: 'secret' },
        value: 'secret',
      },
    },
  }
  const parsed = parseCreate(value)
  expect(parsed.context.route).toBe('/')
  expect(parsed.context.element.styles).toEqual({ color: 'red' })
  expect(parsed.context).not.toHaveProperty('file')
  expect(parsed.context.element).not.toHaveProperty('value')
  expect(() => parseCreate({ ...value, requestId: '../etc/passwd' })).toThrow()
  expect(() =>
    parseCreate({ ...value, context: { ...value.context, instruction: 'x'.repeat(4001) } }),
  ).toThrow()
})
test('requires loopback and exact Host/Origin', () => {
  const request = (host: string, origin?: string, address = '127.0.0.1') =>
    ({ headers: { host, origin }, socket: { remoteAddress: address } }) as IncomingMessage
  expect(allowedConnection(request('localhost:5173', 'http://localhost:5173'), false)).toBe(true)
  expect(allowedConnection(request('[::1]:5173', 'http://[::1]:5173', '::1'), false)).toBe(true)
  expect(allowedConnection(request('localhost:5173', 'http://evil.example'), false)).toBe(false)
  expect(allowedConnection(request('evil.example:5173', 'http://evil.example:5173'), false)).toBe(
    false,
  )
  expect(allowedConnection(request('localhost:5173'), false)).toBe(false)
  expect(
    allowedConnection(request('localhost:5173', 'http://localhost:5173', '192.168.1.2'), false),
  ).toBe(false)
})
test('allowLan accepts LAN clients but still requires same-origin Host/Origin', () => {
  const request = (host: string, origin?: string, address = '192.168.1.2') =>
    ({ headers: { host, origin }, socket: { remoteAddress: address } }) as IncomingMessage
  expect(
    allowedConnection(request('192.168.1.1:5173', 'http://192.168.1.1:5173'), false, true),
  ).toBe(true)
  expect(allowedConnection(request('192.168.1.1:5173', 'http://evil.example'), false, true)).toBe(
    false,
  )
  expect(
    allowedConnection(request('192.168.1.1:5173', 'http://192.168.1.1:9999'), false, true),
  ).toBe(false)
  expect(allowedConnection(request('192.168.1.1:5173'), false, true)).toBe(false)
  expect(allowedConnection(request('localhost:5173', 'http://localhost:5173'), false, true)).toBe(
    true,
  )
})

test('missing React runtime peers fail with an installation hint before task services start', async () => {
  const plugin = domino() as any
  await plugin.configResolved({ root: process.cwd(), base: '/' })
  const requests: string[] = []
  await expect(
    plugin.configureServer({
      httpServer: {},
      environments: {
        client: {
          pluginContainer: {
            resolveId: async (id: string) => {
              requests.push(id)
              return id === 'react-dom/client' ? null : { id }
            },
          },
        },
      },
    }),
  ).rejects.toMatchObject({
    code: 'RUNTIME_DEPENDENCY_MISSING',
    message: expect.stringContaining('npm install react@^19 react-dom@^19'),
  })
  expect(requests).toEqual(['react', 'react/jsx-runtime', 'react-dom/client'])
})
