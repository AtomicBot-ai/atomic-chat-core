/**
 * Reduces an internal `BackendTarget` to today's desktop `SessionInfo.port` representation.
 *
 * ADR T01e (`docs/decisions/2026-09-23-preserve-deployment-seams.md`): production desktop adapters
 * publish only on exactly `127.0.0.1` over plain `http`, at an explicit, valid TCP port, with an
 * empty or root path and no credentials, query or fragment. Projecting another loopback spelling
 * (`localhost`, `::1`, `127.0.0.2`, ...) to just a port would point an existing caller that already
 * assumes `127.0.0.1` — the app, the public server's forwarder — at the wrong listener. Anything
 * that does not fit is refused here, before publication, rather than silently reduced.
 */
import { AtomicCoreError } from '../../contracts/index.js'
import type { BackendTarget } from './types.js'

const DESKTOP_HOST = '127.0.0.1'

function refuse(baseUrl: string, why: string): never {
  throw new AtomicCoreError(
    'FORBIDDEN_HOST',
    `Managed backend target cannot be published as a desktop session: ${why}.`,
    baseUrl
  )
}

/** Pure: throws `AtomicCoreError('FORBIDDEN_HOST', ...)` rather than return an unpublishable port. */
export function projectSessionPort(target: BackendTarget): number {
  let url: URL
  try {
    url = new URL(target.base_url)
  } catch {
    return refuse(target.base_url, 'base_url is not a valid URL')
  }

  if (url.protocol !== 'http:') {
    return refuse(target.base_url, `protocol is ${url.protocol.replace(':', '')}, not http`)
  }
  if (url.hostname !== DESKTOP_HOST) {
    return refuse(target.base_url, `host is not exactly ${DESKTOP_HOST}`)
  }
  if (url.username !== '' || url.password !== '') {
    return refuse(target.base_url, 'URL carries credentials')
  }
  if (url.search !== '') {
    return refuse(target.base_url, 'URL carries a query string')
  }
  if (url.hash !== '') {
    return refuse(target.base_url, 'URL carries a fragment')
  }
  if (url.pathname !== '/') {
    return refuse(target.base_url, 'URL is not the server root')
  }
  if (url.port === '') {
    return refuse(target.base_url, 'URL has no explicit port')
  }

  const port = Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return refuse(target.base_url, 'port is out of range')
  }

  return port
}
