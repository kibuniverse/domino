import type { IncomingMessage, ServerResponse } from 'node:http'

export function isLoopback(address?: string): boolean {
  return !!address && (address === '::1' || /^127\./.test(address) || /^::ffff:127\./.test(address))
}
export function allowedConnection(request: IncomingMessage, https: boolean, allowLan = false): boolean {
  if ((!allowLan && !isLoopback(request.socket.remoteAddress)) || !request.headers.host || !request.headers.origin) return false
  try {
    const origin = new URL(request.headers.origin)
    const host = new URL(`${https ? 'https' : 'http'}://${request.headers.host}`)
    return (allowLan || ['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)) && origin.origin === host.origin
  } catch { return false }
}

export function protectStorage(request: IncomingMessage, response: ServerResponse, next: () => void) {
  let path: string
  try { path = decodeURIComponent((request.url ?? '').split('?')[0]).replaceAll('\\', '/') }
  catch { response.statusCode = 400; response.end('Invalid URL'); return }
  if (/(?:^|\/)\.domino(?:\/|$)/i.test(path)) {
    response.statusCode = 403
    response.end('Forbidden')
    return
  }
  next()
}
