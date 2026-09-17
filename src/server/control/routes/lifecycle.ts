/**
 * The routes that describe and end the core itself: health, snapshot, the event stream and shutdown.
 * Shutdown registers last, after every other family, so it lives in its own function.
 */

import { AtomicCoreError, CONTROL_PROTOCOL_VERSION } from '../../../contracts/index.js'
import { queryOf, readJsonBody, sendError, sendJson } from '../../http.js'
import type { Router } from '../../http.js'
import type { ControlRouteContext, ControlServerDeps } from '../types.js'

/** `/health`, `/snapshot` and `/events`. */
export function registerLifecycleRoutes(
  router: Router,
  deps: ControlServerDeps,
  ctx: ControlRouteContext
): void {
  const { p, now, startedAt, snapshot, self } = ctx

  router.get(p('/health'), (_req, res) => {
    sendJson(res, 200, {
      ok: true,
      pid: process.pid,
      version: deps.version,
      owner_scope: deps.ownerScope,
      instance_id: deps.instanceId,
      protocol: CONTROL_PROTOCOL_VERSION,
      dataFolder: deps.dataFolder,
      uptime_ms: now() - startedAt,
    })
  })

  router.get(p('/snapshot'), (_req, res) => sendJson(res, 200, snapshot()))

  router.get(p('/events'), (req, res) => {
    const cursor = queryOf(req).get('cursor') ?? (req.headers['last-event-id'] as string | undefined) ?? ''
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    })
    // Headers must reach the client before any event does: a reader that is waiting for the response
    // would otherwise block until the first event, which may be minutes away.
    res.flushHeaders()
    const afterSeq = cursor ? deps.emitter.parseCursor(cursor) : deps.emitter.lastSeq
    const replay = afterSeq === undefined ? undefined : deps.emitter.replayAfter(afterSeq)
    if (replay === undefined) {
      // Cursor from another instance, or older than the ring: the client must take a fresh snapshot.
      res.write(
        sseFrame(deps.emitter.cursor(), 'resync', { reason: cursor ? 'cursor-expired' : 'no-cursor' })
      )
    } else {
      for (const record of replay)
        res.write(sseFrame(deps.emitter.cursor(record.seq), record.name, record.payload))
    }
    self()?.attachSse(res)
    req.on('close', () => res.end())
  })
}

/** `/shutdown`. */
export function registerShutdownRoute(
  router: Router,
  deps: ControlServerDeps,
  ctx: ControlRouteContext
): void {
  const { p } = ctx

  router.post(p('/shutdown'), async (req, res) => {
    const body = await readJsonBody<{ force?: boolean; client_id?: string }>(req)
    const others = deps.clients.acceptShutdown(body.client_id, body.force === true)
    if (others.length > 0 && body.force !== true) {
      return sendError(
        res,
        new AtomicCoreError(
          'CORE_ALREADY_RUNNING',
          'Other clients are still attached to this core.',
          others.map((c) => `${c.name}${c.pid ? ` (pid ${c.pid})` : ''}`).join(', ')
        )
      )
    }
    sendJson(res, 200, { ok: true, stopping: true })
    setTimeout(() => {
      void deps.shutdown({ force: body.force === true, requestedBy: body.client_id })
    }, 10).unref?.()
  })
}

/** One SSE frame; shared by the events route (replay, resync) and the server (live broadcast). */
export function sseFrame(id: string, event: string, data: unknown): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}
