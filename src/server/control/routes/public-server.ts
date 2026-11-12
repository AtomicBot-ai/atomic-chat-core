/** The public `/v1` listener: status, start, stop, the inspector toggle, selection and client keys. */

import { AtomicCoreError } from '../../../contracts/index.js'
import type { ServedModelSelection } from '../../../contracts/index.js'
import { readJsonBody, sendError, sendJson } from '../../http.js'
import type { Router } from '../../http.js'
import type { ControlRouteContext, ControlServerDeps } from '../types.js'

export function registerPublicServerRoutes(
  router: Router,
  deps: ControlServerDeps,
  ctx: ControlRouteContext
): void {
  const { p } = ctx

  router.get(p('/server'), (_req, res) => sendJson(res, 200, deps.publicServer.status()))

  router.post(p('/server/start'), async (req, res) => {
    const body = await readJsonBody<{
      host?: string
      port?: number
      prefix?: string
      api_key?: string
      trusted_hosts?: string[]
      proxy_timeout_secs?: number
      state_file?: boolean
      fallback_port?: boolean
    }>(req)
    const state = await deps.publicServer.start({
      ...(body.host !== undefined ? { host: body.host } : {}),
      ...(body.port !== undefined ? { port: body.port } : {}),
      ...(body.prefix !== undefined ? { prefix: body.prefix } : {}),
      ...(body.api_key !== undefined ? { apiKey: body.api_key } : {}),
      ...(body.trusted_hosts !== undefined ? { trustedHosts: body.trusted_hosts } : {}),
      ...(body.proxy_timeout_secs !== undefined ? { proxyTimeoutSecs: body.proxy_timeout_secs } : {}),
      ...(body.state_file !== undefined ? { writeStateFile: body.state_file === true } : {}),
      ...(body.fallback_port !== undefined ? { fallbackPort: body.fallback_port === true } : {}),
    })
    sendJson(res, 200, state)
  })

  router.post(p('/server/stop'), async (_req, res) => sendJson(res, 200, await deps.publicServer.stop()))

  router.put(p('/server/inspector'), async (req, res) => {
    const body = await readJsonBody<{ enabled?: unknown }>(req)
    if (typeof body.enabled !== 'boolean')
      return sendError(
        res,
        new AtomicCoreError('INVALID_ARGUMENT', 'inspector needs {"enabled": true|false}')
      )
    deps.publicServer.setInspecting(body.enabled)
    sendJson(res, 200, { enabled: body.enabled })
  })

  router.get(p('/server/selection'), (_req, res) =>
    sendJson(res, 200, { models: deps.publicServer.selection() })
  )

  // The whole selection, replaced: the app sends what its server page shows after every change.
  router.put(p('/server/selection'), async (req, res) => {
    const models = parseSelection(await readJsonBody<unknown>(req))
    if (!models)
      return sendError(
        res,
        new AtomicCoreError(
          'INVALID_ARGUMENT',
          'selection needs {"models": [{"model": "<id>", "provider": "<provider>"}]} with non-empty strings'
        )
      )
    deps.publicServer.setSelection(models)
    sendJson(res, 200, { models: deps.publicServer.selection() })
  })

  // The whole list, replaced: the app sends every paired device's key after each change and after
  // every reattach. The answer is only the count; a key is never echoed, logged or read back.
  router.put(p('/server/client-keys'), async (req, res) => {
    const keys = parseClientKeys(await readJsonBody<unknown>(req))
    if (!keys)
      return sendError(
        res,
        new AtomicCoreError(
          'INVALID_ARGUMENT',
          `client keys need {"keys": [...]} with at most ${MAX_CLIENT_KEYS} strings of ` +
            `${MIN_CLIENT_KEY_LENGTH}–${MAX_CLIENT_KEY_LENGTH} characters from [A-Za-z0-9._~-]`
        )
      )
    deps.publicServer.setClientKeys(keys)
    sendJson(res, 200, { count: keys.length })
  })
}

const MAX_CLIENT_KEYS = 200
const MIN_CLIENT_KEY_LENGTH = 20
const MAX_CLIENT_KEY_LENGTH = 256
/** The characters a client key may use: unreserved URL characters, so a key fits any header as is. */
const CLIENT_KEY = /^[A-Za-z0-9._~-]+$/

function parseClientKeys(body: unknown): string[] | undefined {
  const keys = typeof body === 'object' && body !== null ? (body as { keys?: unknown }).keys : undefined
  if (!Array.isArray(keys) || keys.length > MAX_CLIENT_KEYS) return undefined
  const valid = keys.every(
    (key): key is string =>
      typeof key === 'string' &&
      key.length >= MIN_CLIENT_KEY_LENGTH &&
      key.length <= MAX_CLIENT_KEY_LENGTH &&
      CLIENT_KEY.test(key)
  )
  return valid ? [...(keys as string[])] : undefined
}

function parseSelection(body: unknown): ServedModelSelection[] | undefined {
  const models = typeof body === 'object' && body !== null ? (body as { models?: unknown }).models : undefined
  if (!Array.isArray(models)) return undefined
  const parsed: ServedModelSelection[] = []
  for (const entry of models) {
    const { model, provider } = (typeof entry === 'object' && entry !== null ? entry : {}) as {
      model?: unknown
      provider?: unknown
    }
    if (typeof model !== 'string' || typeof provider !== 'string' || model === '' || provider === '')
      return undefined
    parsed.push({ model, provider })
  }
  return parsed
}
