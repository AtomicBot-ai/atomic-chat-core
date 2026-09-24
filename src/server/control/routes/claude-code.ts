import { once } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AtomicCoreError } from '../../../contracts/index.js'
import type { ClaudeCodeEvent, ClaudeCodeRequest } from '../../../contracts/index.js'
import { readJsonBody, sendJson } from '../../http.js'
import type { Router } from '../../http.js'
import type { ControlRouteContext, ControlServerDeps } from '../types.js'

function disconnected(req: IncomingMessage, res: ServerResponse): AbortController {
  const controller = new AbortController()
  const abort = () => controller.abort()
  req.once('aborted', abort)
  res.once('close', abort)
  return controller
}

/** Only registered on the token-authenticated control listener, never /v1. */
export function registerClaudeCodeRoutes(
  router: Router,
  deps: ControlServerDeps,
  ctx: ControlRouteContext
): void {
  const runtime = () => {
    if (!deps.claudeCode)
      throw new AtomicCoreError(
        'BINARY_NOT_FOUND',
        'This core does not support Claude Code. Update the Atomic Chat core.'
      )
    return deps.claudeCode
  }
  router.get(ctx.p('/claude-code/status'), async (req, res) => {
    const signal = disconnected(req, res).signal
    sendJson(res, 200, await runtime().status(signal))
  })
  router.post(ctx.p('/claude-code/login'), async (req, res) => {
    await runtime().login(disconnected(req, res).signal)
    sendJson(res, 200, { connected: true })
  })
  router.post(ctx.p('/claude-code/chat'), async (req, res) => {
    const body = await readJsonBody<ClaudeCodeRequest>(req)
    const claude = runtime()
    const signal = disconnected(req, res).signal
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    })
    const emit = async (event: ClaudeCodeEvent) => {
      signal.throwIfAborted()
      if (!res.write(`data: ${JSON.stringify(event)}\n\n`)) await once(res, 'drain', { signal })
    }
    try {
      const result = await claude.chat(body, emit, signal)
      await emit({ type: 'result', result })
    } catch (error) {
      if (!signal.aborted)
        await emit({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      res.end()
    }
  })
}
