/**
 * The `/engines` layer's routes (change `unify-engine-lifecycle`, spec `engine-lifecycle`, design D2,
 * D10): the versions of every engine of this host, an update, an activation and the removal of one
 * build. The versions and the update are POST: the proxy policy may carry credentials, which never
 * travel in a query string.
 *
 * Bodies are checked here, unknown fields included, as on `/engine-builds`: a field this build would
 * silently ignore means something to the caller and nothing to the core. Which body an update takes
 * depends on the engine: `{task_id, target?, …}` for the engines that swap a build, `{request_id,
 * app_version?}` for the managed ones, which answer `202` with the operation they began.
 */

import { AtomicCoreError, ENGINE_IDS, ENGINE_KINDS } from '../../../contracts/index.js'
import type {
  EngineId,
  EngineReinstallRequest,
  EngineSwapUpdateRequest,
  EngineUpdateRequest,
  EngineVersionsRequest,
  ProxyConfig,
} from '../../../contracts/index.js'
import { queryOf, readJsonBody, sendJson } from '../../http.js'
import type { Router } from '../../http.js'
import type { ControlRouteContext, ControlServerDeps, EngineControl } from '../types.js'

const invalid = (why: string, details?: string): never => {
  throw new AtomicCoreError('INVALID_ARGUMENT', why, details)
}

/** A task or request id is an event name and a key on disk; a path segment is a folder name. */
const ID_SHAPE = /^[^/\\]{1,200}$/
const SEGMENT_SHAPE = /^[A-Za-z0-9._-]{1,200}$/
/** A managed engine's build variant is its image platform (`linux%2Famd64` in the path). */
const PLATFORM_SHAPE = /^linux\/(amd64|arm64)$/

function engineOf(raw: string | undefined): EngineId {
  if (raw === undefined || !(ENGINE_IDS as readonly string[]).includes(raw))
    return invalid(`There is no engine named ${raw ?? ''}.`, raw)
  return raw as EngineId
}

function object(value: unknown, what = 'The request body'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return invalid(`${what} must be a JSON object.`)
  return value as Record<string, unknown>
}

function known(body: Record<string, unknown>, keys: readonly string[]): void {
  const extra = Object.keys(body).filter((key) => !keys.includes(key))
  if (extra.length > 0) invalid('The request has fields this core does not know.', extra.sort().join(', '))
}

function id(value: unknown, name: string): string {
  if (typeof value !== 'string' || !ID_SHAPE.test(value) || [...value].some((ch) => ch.charCodeAt(0) < 0x20))
    return invalid(`${name} must be a non-empty id without slashes.`)
  return value
}

function segment(value: unknown, name: string): string {
  if (typeof value !== 'string' || !SEGMENT_SHAPE.test(value) || value === '.' || value === '..')
    return invalid(`${name} is not a build identifier.`, typeof value === 'string' ? value : undefined)
  return value
}

function variantOf(engine: EngineId, value: string | undefined): string {
  if (ENGINE_KINDS[engine] === 'managed') {
    if (value === undefined || !PLATFORM_SHAPE.test(value))
      return invalid(
        'A managed engine build is named by its image platform: linux/amd64 or linux/arm64.',
        value
      )
    return value
  }
  return segment(value, 'variant')
}

function appVersion(body: Record<string, unknown>): { app_version?: string | null } {
  const value = body['app_version']
  if (value === undefined) return {}
  if (value !== null && typeof value !== 'string') invalid('app_version must be a string or null.')
  return { app_version: value as string | null }
}

function forceAndProxy(body: Record<string, unknown>): { force?: boolean; proxy?: ProxyConfig | null } {
  const { force, proxy } = body
  if (force !== undefined && typeof force !== 'boolean') invalid('force must be a boolean.')
  if (proxy !== undefined && proxy !== null && (typeof proxy !== 'object' || Array.isArray(proxy)))
    invalid('proxy must be an object or null.')
  return {
    ...(force !== undefined ? { force: force as boolean } : {}),
    ...(proxy !== undefined ? { proxy: proxy as ProxyConfig | null } : {}),
  }
}

export function parseEngineVersionsBody(raw: unknown): EngineVersionsRequest {
  const body = object(raw)
  known(body, ['force', 'proxy', 'app_version'])
  return { ...forceAndProxy(body), ...appVersion(body) }
}

export function parseEngineUpdateBody(engine: EngineId, raw: unknown): EngineUpdateRequest {
  const body = object(raw)
  if (ENGINE_KINDS[engine] === 'managed') {
    known(body, ['request_id', 'app_version'])
    const request: EngineReinstallRequest = {
      request_id: id(body['request_id'], 'request_id'),
      ...appVersion(body),
    }
    return request
  }
  known(body, ['task_id', 'target', 'force', 'proxy', 'app_version'])
  const request: EngineSwapUpdateRequest = {
    task_id: id(body['task_id'], 'task_id'),
    ...forceAndProxy(body),
    ...appVersion(body),
  }
  if (body['target'] !== undefined) {
    if (ENGINE_KINDS[engine] !== 'llamacpp')
      invalid(`The core picks the ${engine} build for this computer; an update takes no target.`)
    const target = object(body['target'], 'target')
    known(target, ['version', 'variant'])
    request.target = {
      ...(target['version'] !== undefined ? { version: segment(target['version'], 'target.version') } : {}),
      variant: segment(target['variant'], 'target.variant'),
    }
  }
  return request
}

function retainModels(req: Parameters<typeof queryOf>[0]): { retainModels?: boolean } {
  const raw = queryOf(req).get('retain_models')
  if (raw === null) return {}
  if (raw !== 'true' && raw !== 'false') return invalid('retain_models must be true or false.', raw)
  return { retainModels: raw === 'true' }
}

/** Without the layer wired (a core built without it), every route says so rather than 404. */
function enginesOf(deps: ControlServerDeps): EngineControl {
  if (deps.engines === undefined)
    throw new AtomicCoreError('INVALID_ARGUMENT', 'This core does not manage engines through /engines.')
  return deps.engines
}

/** A managed engine's update and removal answer with the operation they began. */
const statusOf = (result: object): number => ('operation_id' in result ? 202 : 200)

export function registerEngineRoutes(
  router: Router,
  deps: ControlServerDeps,
  ctx: ControlRouteContext
): void {
  const { p } = ctx

  router.post(p('/engines/versions'), async (req, res) => {
    const request = parseEngineVersionsBody(await readJsonBody(req))
    sendJson(res, 200, await enginesOf(deps).versions(request))
  })

  // Synchronous for the engines that swap a build, like `POST /engine-builds/:engine/install`:
  // progress and cancel go through `download:*` and `POST /downloads/:task_id/cancel`.
  router.post(p('/engines/:engine/update'), async (req, res, { params }) => {
    const engine = engineOf(params['engine'])
    const request = parseEngineUpdateBody(engine, await readJsonBody(req))
    const result = await enginesOf(deps).update(engine, request)
    sendJson(res, statusOf(result), result)
  })

  router.delete(p('/engines/:engine/builds/:version/:variant'), async (req, res, { params }) => {
    const engine = engineOf(params['engine'])
    const version = segment(params['version'], 'version')
    const variant = variantOf(engine, params['variant'])
    const result = await enginesOf(deps).remove(engine, version, variant, retainModels(req))
    sendJson(res, statusOf(result), result)
  })

  router.post(p('/engines/:engine/builds/:version/:variant/activate'), async (req, res, { params }) => {
    const engine = engineOf(params['engine'])
    const version = segment(params['version'], 'version')
    const variant = variantOf(engine, params['variant'])
    known(object(await readJsonBody(req)), [])
    sendJson(res, 200, await enginesOf(deps).activate(engine, version, variant))
  })
}
