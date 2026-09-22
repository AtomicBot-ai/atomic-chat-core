/** A Sentry DSN split into what an envelope POST needs. */
export interface ParsedDsn {
  /** The original DSN; it goes into the envelope header. */
  dsn: string
  publicKey: string
  host: string
  projectId: string
  /** `<scheme>//<host>[<path>]/api/<project>/envelope/` */
  envelopeUrl: string
}

/**
 * Parse `<scheme>://<public key>@<host>[/<path>]/<project id>`. Returns null for anything else, so a
 * malformed secret leaves reporting off instead of throwing at start-up.
 */
export function parseDsn(raw: string | undefined): ParsedDsn | null {
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (!url.username) return null
  const segments = url.pathname.split('/').filter(Boolean)
  const projectId = segments.pop()
  if (!projectId || !/^\d+$/.test(projectId)) return null
  const basePath = segments.length ? `/${segments.join('/')}` : ''
  return {
    dsn: raw.trim(),
    publicKey: decodeURIComponent(url.username),
    host: url.host,
    projectId,
    envelopeUrl: `${url.protocol}//${url.host}${basePath}/api/${projectId}/envelope/`,
  }
}
