/**
 * The managed container runtime over the control API: what the machine would need, starting the
 * change, watching it, and coming back to it after the app was closed or the machine restarted.
 *
 * Bodies are validated here rather than trusted, including their unknown fields. A field this build
 * would silently ignore is a request that means something to the caller and nothing to us, and on a
 * surface where one of the calls ends in a password prompt that is worth refusing outright.
 *
 * The privileged step is the reason the shapes look the way they do. The core never runs it: it
 * hands out a step bound to one operation, one revision and a single-use nonce, and the app comes
 * back with a receipt naming all three. A replayed receipt answers with the state as it stands
 * instead of authorizing anything a second time.
 */

import { AtomicCoreError, MANAGED_OPERATION_KINDS } from '../../../contracts/index.js'
import type {
  BeginOperation,
  ManagedHostReceipt,
  ManagedOperationTarget,
  ProbeEnvironmentInput,
  ResumeOperation,
  Sha256Digest,
} from '../../../contracts/index.js'
import { readJsonBody, sendJson } from '../../http.js'
import type { Router } from '../../http.js'
import type { ControlRouteContext, ControlServerDeps } from '../types.js'

const invalid = (why: string, details?: string): never => {
  throw new AtomicCoreError('INVALID_ARGUMENT', why, details)
}

const unavailable = (): never => {
  throw new AtomicCoreError(
    'MANAGED_ADAPTER_UNAVAILABLE',
    'Managed runtimes are not available in this build.'
  )
}

const DIGEST = /^sha256:[0-9a-f]{64}$/
/** Ids travel in a path segment and become a directory name; anything else is a caller's mistake. */
const ID_SHAPE = /^[^/\\]{1,200}$/
const isId = (value: string): boolean =>
  ID_SHAPE.test(value) && ![...value].some((ch) => ch.charCodeAt(0) < 0x20)

const object = (value: unknown, at: string): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : (invalid(`${at} must be an object.`) as never)

const known = (source: Record<string, unknown>, at: string, keys: readonly string[]): void => {
  const extra = Object.keys(source).filter((key) => !keys.includes(key))
  if (extra.length > 0) invalid(`${at} has fields this core does not know.`, extra.sort().join(', '))
}

const id = (value: unknown, at: string): string =>
  typeof value === 'string' && isId(value) ? value : (invalid(`${at} is not a valid id.`) as never)

const digest = (value: unknown, at: string): Sha256Digest =>
  typeof value === 'string' && DIGEST.test(value)
    ? (value as Sha256Digest)
    : (invalid(`${at} is not a sha256 digest.`) as never)

const revision = (value: unknown, at: string): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : (invalid(`${at} is not a revision.`) as never)

const oneOf = <T extends string>(value: unknown, at: string, allowed: readonly T[]): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : (invalid(`${at} must be one of: ${allowed.join(', ')}.`) as never)

const target = (value: unknown, at: string): ManagedOperationTarget => {
  const raw = object(value, at)
  const kind = oneOf(raw['kind'], `${at}.kind`, ['environment', 'runtime'] as const)
  if (kind === 'environment') {
    known(raw, at, ['kind'])
    return { kind }
  }
  known(raw, at, ['kind', 'installation_id', 'engine_id'])
  return {
    kind,
    installation_id: id(raw['installation_id'], `${at}.installation_id`),
    engine_id: id(raw['engine_id'], `${at}.engine_id`),
  }
}

const beginBody = (value: unknown): BeginOperation => {
  const raw = object(value, 'the request')
  known(raw, 'the request', [
    'request_id',
    'target',
    'kind',
    'descriptor_id',
    'retain_models',
    'approved_plan_digest',
  ])
  const kind = oneOf(raw['kind'], 'kind', MANAGED_OPERATION_KINDS)
  // Setting something up or replacing it needs to say what with; a removal already knows.
  if (kind !== 'remove' && raw['descriptor_id'] === undefined) {
    invalid('A setup or an update has to name the runtime it installs.', 'descriptor_id')
  }
  if (raw['retain_models'] !== undefined && typeof raw['retain_models'] !== 'boolean') {
    invalid('retain_models must be true or false.')
  }
  return {
    request_id: id(raw['request_id'], 'request_id'),
    target: target(raw['target'], 'target'),
    kind,
    ...(raw['descriptor_id'] === undefined
      ? {}
      : { descriptor_id: id(raw['descriptor_id'], 'descriptor_id') }),
    ...(raw['retain_models'] === undefined ? {} : { retain_models: raw['retain_models'] as boolean }),
    ...(raw['approved_plan_digest'] === undefined
      ? {}
      : { approved_plan_digest: digest(raw['approved_plan_digest'], 'approved_plan_digest') }),
  }
}

const resumeBody = (value: unknown): ResumeOperation => {
  const raw = object(value, 'the request')
  known(raw, 'the request', ['expected_revision', 'approved_plan_digest'])
  return {
    expected_revision: revision(raw['expected_revision'], 'expected_revision'),
    ...(raw['approved_plan_digest'] === undefined
      ? {}
      : { approved_plan_digest: digest(raw['approved_plan_digest'], 'approved_plan_digest') }),
  }
}

const probeBody = (value: unknown): ProbeEnvironmentInput => {
  const raw = object(value, 'the request')
  known(raw, 'the request', ['descriptor_id', 'environment_id', 'target'])
  return {
    descriptor_id: id(raw['descriptor_id'], 'descriptor_id'),
    ...(raw['environment_id'] === undefined
      ? {}
      : { environment_id: id(raw['environment_id'], 'environment_id') }),
    target: target(raw['target'], 'target'),
  }
}

const receiptBody = (value: unknown): ManagedHostReceipt => {
  const raw = object(value, 'the request')
  known(raw, 'the request', [
    'step_id',
    'nonce',
    'expected_operation_revision',
    'recipe_digest',
    'parameters_digest',
    'outcome',
    'receipt_id',
  ])
  return {
    step_id: id(raw['step_id'], 'step_id'),
    nonce: id(raw['nonce'], 'nonce'),
    expected_operation_revision: revision(raw['expected_operation_revision'], 'expected_operation_revision'),
    recipe_digest: digest(raw['recipe_digest'], 'recipe_digest'),
    parameters_digest: digest(raw['parameters_digest'], 'parameters_digest'),
    outcome: oneOf(raw['outcome'], 'outcome', [
      'completed',
      'declined',
      'relogin-required',
      'reboot-required',
      'failed',
    ] as const),
    receipt_id: id(raw['receipt_id'], 'receipt_id'),
  }
}

export function registerEnvironmentRoutes(
  router: Router,
  deps: ControlServerDeps,
  ctx: ControlRouteContext
): void {
  const { p } = ctx
  const service = () => deps.environments ?? (unavailable() as never)

  router.get(p('/environments'), async (_req, res) => {
    sendJson(res, 200, { environments: await service().list() })
  })

  // A POST, not a query: the target and the descriptor are structured, and probing changes nothing.
  router.post(p('/environments/probe'), async (req, res) => {
    const body = await readJsonBody<unknown>(req)
    sendJson(res, 200, await service().probe(probeBody(body)))
  })

  // Registered before the `:operationId` family so neither pattern can swallow the other.
  router.get(p('/environments/operations/:operationId'), async (_req, res, { params }) => {
    sendJson(res, 200, await service().get(id(params['operationId'], 'operationId')))
  })

  router.post(p('/environments/operations/:operationId/cancel'), async (_req, res, { params }) => {
    sendJson(res, 200, await service().cancel(id(params['operationId'], 'operationId')))
  })

  router.post(p('/environments/operations/:operationId/resume'), async (req, res, { params }) => {
    const body = await readJsonBody<unknown>(req)
    sendJson(res, 200, await service().resume(id(params['operationId'], 'operationId'), resumeBody(body)))
  })

  router.post(p('/environments/operations/:operationId/host-step-result'), async (req, res, { params }) => {
    const body = await readJsonBody<unknown>(req)
    sendJson(
      res,
      200,
      await service().acceptHostReceipt(id(params['operationId'], 'operationId'), receiptBody(body))
    )
  })

  // 202: the operation is recorded and running, and the work it starts outlives this request.
  router.post(p('/environments/:environmentId/operations'), async (req, res, { params }) => {
    const body = await readJsonBody<unknown>(req)
    const operation = await service().begin(id(params['environmentId'], 'environmentId'), beginBody(body))
    sendJson(res, 202, operation)
  })
}
