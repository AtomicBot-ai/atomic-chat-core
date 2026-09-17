/** `server status` — probe the local API server and list what it serves. */

import { parseArgs } from 'node:util'
import type { LocalApiServerState } from '../../contracts/index.js'
import type { DataLayout } from '../../config/index.js'
import { withAttachedOwner } from '../owner.js'
import type { CliIo } from '../io.js'
import { apiUrl, baseUrl, layoutFor } from './shared.js'

/** `server status` — is a local API server reachable, and what does it serve? */
export async function serverCommand(argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      'data-folder': { type: 'string' },
      'host': { type: 'string' },
      'port': { type: 'string' },
      'prefix': { type: 'string' },
      'api-key': { type: 'string' },
      'json': { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })
  const sub = positionals[0] ?? 'status'
  if (sub !== 'status') {
    io.stderr(`Unknown server subcommand: ${sub}\n`)
    return 2
  }
  const layout = layoutFor(values, io)
  const state = await readServerState(layout, values, io)
  const apiKey = values['api-key'] ?? io.env['ATOMIC_API_KEY'] ?? ''
  const reachable = await probe(state, io)
  const models = reachable ? await fetchModels(state, apiKey, io) : { error: 'server not reachable' }

  if (values.json) {
    io.stdout(
      `${JSON.stringify(
        {
          running: reachable,
          url: apiUrl(state),
          host: state.host,
          port: state.port,
          prefix: state.prefix,
          requires_api_key: state.requires_api_key,
          models: 'models' in models ? models.models : null,
          models_error: 'error' in models ? models.error : null,
        },
        null,
        2
      )}\n`
    )
  } else if (reachable) {
    io.stdout(`\n  ● Local API Server is running\n`)
    io.stdout(`  Endpoint  ${apiUrl(state)}\n`)
    if ('models' in models)
      io.stdout(`  Models    ${models.models.length ? models.models.join(', ') : 'none loaded'}\n`)
    else io.stdout(`  Models    ${models.error}\n`)
    io.stdout('\n')
  } else {
    io.stdout(`\n  ○ No Local API Server at ${apiUrl(state)}\n\n`)
  }
  return reachable ? 0 : 1
}

async function readServerState(
  layout: DataLayout,
  values: Record<string, unknown>,
  io: CliIo
): Promise<LocalApiServerState> {
  // Prefer the running core's own state; fall back to the app's state file, then to defaults.
  let state: LocalApiServerState = {
    running: false,
    host: '127.0.0.1',
    port: 1337,
    prefix: '/v1',
    requires_api_key: false,
    pid: null,
  }
  try {
    state = await withAttachedOwner({ layout, clientName: 'atomic-chat-core server status' }, ({ client }) =>
      client.serverStatus()
    )
  } catch {
    // A crashed core can leave a stale discovery file beside a live legacy app state. Parse both
    // and prefer the first endpoint that actually answers instead of letting file age decide.
    const candidates: LocalApiServerState[] = []
    for (const fromFile of [
      await io.readFile(layout.core.publicServerState),
      await io.readFile(layout.serverStateFile),
    ]) {
      if (!fromFile) continue
      try {
        const parsed = JSON.parse(fromFile) as Partial<LocalApiServerState>
        if (typeof parsed.port === 'number' && typeof parsed.host === 'string')
          candidates.push({ ...state, ...parsed, pid: parsed.pid ?? null })
      } catch {
        /* a malformed state file means "unknown", not "crash" */
      }
    }
    state = candidates[0] ?? state
    for (const candidate of candidates) {
      if (await probe(candidate, io)) {
        state = candidate
        break
      }
    }
  }
  if (typeof values['host'] === 'string') state.host = values['host']
  if (values['port'] !== undefined) state.port = Number(values['port'])
  if (typeof values['prefix'] === 'string') state.prefix = values['prefix']
  return state
}

async function probe(state: LocalApiServerState, io: CliIo): Promise<boolean> {
  const res = await io
    .fetch(`${baseUrl(state)}/`, { signal: AbortSignal.timeout(3000) })
    .catch(() => undefined)
  return res !== undefined && res.ok
}

async function fetchModels(
  state: LocalApiServerState,
  apiKey: string,
  io: CliIo
): Promise<{ models: string[] } | { error: string }> {
  const res = await io
    .fetch(`${apiUrl(state)}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(5000),
    })
    .catch((e: Error) => e)
  if (res instanceof Error) return { error: res.message }
  if (res.status === 401)
    return { error: 'server requires an API key — pass --api-key or set ATOMIC_API_KEY' }
  if (!res.ok) return { error: `server returned ${res.status}` }
  const body = (await res.json().catch(() => ({}))) as { data?: Array<{ id?: unknown }> }
  return { models: (body.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean) }
}
