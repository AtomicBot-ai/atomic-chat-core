/**
 * sd.cpp and MLX builds the core installs itself (openspec change `move-sdcpp-mlx-install-to-core`,
 * spec `engine-builds`, design D1, D2). All of them POST or DELETE: the proxy policy may carry
 * credentials, which never travel in a query string.
 *
 * Bodies are checked here, unknown fields included, as on `/environments`: a field this build would
 * silently ignore means something to the caller and nothing to the core.
 */

import { AtomicCoreError } from '../../../contracts/index.js'
import type {
  EngineBuildCatalogRequest,
  EngineBuildInstallRequest,
  ProxyConfig,
} from '../../../contracts/index.js'
import { parseEngineBuildId } from '../../../engine-builds/index.js'
import { readJsonBody, sendJson } from '../../http.js'
import type { Router } from '../../http.js'
import type { ControlRouteContext, ControlServerDeps } from '../types.js'

const invalid = (why: string, details?: string): never => {
  throw new AtomicCoreError('INVALID_ARGUMENT', why, details)
}

/** A task id is an event name and a key in the downloader; a path segment is a folder name. */
const ID_SHAPE = /^[^/\\]{1,200}$/
const SEGMENT_SHAPE = /^[A-Za-z0-9._-]{1,200}$/

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return invalid('The request body must be a JSON object.')
  return value as Record<string, unknown>
}

function known(body: Record<string, unknown>, keys: readonly string[]): void {
  const extra = Object.keys(body).filter((key) => !keys.includes(key))
  if (extra.length > 0) invalid('The request has fields this core does not know.', extra.sort().join(', '))
}

function common(body: Record<string, unknown>): EngineBuildCatalogRequest {
  const { force, proxy } = body
  if (force !== undefined && typeof force !== 'boolean') invalid('force must be a boolean.')
  if (proxy !== undefined && proxy !== null && (typeof proxy !== 'object' || Array.isArray(proxy)))
    invalid('proxy must be an object or null.')
  return {
    ...(force !== undefined ? { force: force as boolean } : {}),
    ...(proxy !== undefined ? { proxy: proxy as ProxyConfig | null } : {}),
  }
}

export function parseEngineBuildReadBody(raw: unknown): EngineBuildCatalogRequest {
  const body = object(raw)
  known(body, ['force', 'proxy'])
  return common(body)
}

export function parseEngineBuildInstallBody(raw: unknown): EngineBuildInstallRequest {
  const body = object(raw)
  known(body, ['task_id', 'force', 'proxy'])
  const taskId = body['task_id']
  if (
    typeof taskId !== 'string' ||
    !ID_SHAPE.test(taskId) ||
    [...taskId].some((ch) => ch.charCodeAt(0) < 0x20)
  )
    invalid('install needs task_id: the download task its progress and cancel run under.')
  return { task_id: taskId as string, ...common(body) }
}

function segment(value: string | undefined, name: string): string {
  if (value === undefined || !SEGMENT_SHAPE.test(value) || value === '.' || value === '..')
    return invalid(`${name} is not a build identifier.`, value)
  return value
}

export function registerEngineBuildRoutes(
  router: Router,
  deps: ControlServerDeps,
  ctx: ControlRouteContext
): void {
  const { p } = ctx

  router.post(p('/engine-builds/:engine/catalog'), async (req, res, { params }) => {
    const engine = parseEngineBuildId(params['engine'] as string)
    sendJson(
      res,
      200,
      await deps.engineBuilds.catalog(engine, parseEngineBuildReadBody(await readJsonBody(req)))
    )
  })

  router.post(p('/engine-builds/:engine/updates'), async (req, res, { params }) => {
    const engine = parseEngineBuildId(params['engine'] as string)
    sendJson(
      res,
      200,
      await deps.engineBuilds.checkUpdates(engine, parseEngineBuildReadBody(await readJsonBody(req)))
    )
  })

  // Synchronous like `POST /backends/:p/install` (design D2): progress and cancel go through
  // `download:*` events and `POST /downloads/:task_id/cancel` under the caller's task id.
  router.post(p('/engine-builds/:engine/install'), async (req, res, { params }) => {
    const engine = parseEngineBuildId(params['engine'] as string)
    sendJson(
      res,
      200,
      await deps.engineBuilds.install(engine, parseEngineBuildInstallBody(await readJsonBody(req)))
    )
  })

  router.delete(p('/engine-builds/:engine/:tag/:backend_id'), async (_req, res, { params }) => {
    const engine = parseEngineBuildId(params['engine'] as string)
    const tag = segment(params['tag'], 'tag')
    const backendId = segment(params['backend_id'], 'backend_id')
    sendJson(res, 200, await deps.engineBuilds.remove(engine, tag, backendId))
  })
}
