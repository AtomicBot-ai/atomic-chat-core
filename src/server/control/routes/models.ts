/**
 * Sessions and models: load, unload, recreate, context increase, context measure and compaction,
 * capabilities, container logs, embeddings, the tensorrt-llm check and deletion, GGUF validation,
 * Foundation Models availability, and the devices a backend reports.
 */

import { AtomicCoreError } from '../../../contracts/index.js'
import { compactRequestOf, contextRequestOf } from '../../compaction/index.js'
import { queryOf, readJsonBody, sendError, sendJson } from '../../http.js'
import type { Router } from '../../http.js'
import type { ContextControl, ControlRouteContext, ControlServerDeps } from '../types.js'

/** A chat's whole history travels in a measure or compact body, images included. */
const CONTEXT_BODY_LIMIT = 64 * 1024 * 1024

function contextControl(deps: ControlServerDeps): ContextControl {
  if (!deps.context) {
    throw new AtomicCoreError('PROVIDER_NOT_FOUND', 'This core does not measure or compact chat context.')
  }
  return deps.context
}

export function registerModelRoutes(router: Router, deps: ControlServerDeps, ctx: ControlRouteContext): void {
  const { p } = ctx

  if (deps.fastFlowLmPreparation) {
    const plan = deps.fastFlowLmPreparation
    router.post(p('/runtimes/fastflowlm/probe'), async (req, res) => {
      const body = await readJsonBody(req)
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)
        throw new AtomicCoreError(
          'INVALID_REQUEST',
          'FastFlowLM probes the current runtime identity and accepts no parameters.'
        )
      sendJson(res, 200, await plan())
    })
  }
  if (deps.fastFlowLmAccelerators) {
    const probe = deps.fastFlowLmAccelerators
    router.get(p('/runtimes/fastflowlm/accelerators'), async (_req, res) => sendJson(res, 200, await probe()))
  }

  router.get(p('/sessions'), (_req, res) => sendJson(res, 200, { sessions: deps.sessions() }))

  // Registered ahead of `load`: a cancel is never queued behind the load it stops.
  router.post(p('/models/:provider/*modelId/load/cancel'), (_req, res, { params }) => {
    const cancelled = deps.cancelModelLoad(params['provider'] as string, params['modelId'] as string)
    sendJson(res, 200, { cancelled })
  })

  router.post(p('/models/:provider/*modelId/load'), async (req, res, { params }) => {
    const body = await readJsonBody<Record<string, unknown>>(req)
    const result = await deps.loadModel(params['provider'] as string, params['modelId'] as string, body)
    sendJson(res, 200, 'session' in result ? result : { session: result, created: true })
  })

  router.post(p('/models/:provider/*modelId/unload'), async (_req, res, { params }) => {
    const result = await deps.unloadModel(params['provider'] as string, params['modelId'] as string)
    sendJson(res, 200, result)
  })

  router.post(p('/models/:provider/*modelId/recreate'), async (_req, res, { params }) => {
    sendJson(res, 200, await deps.recreateSession(params['provider'] as string, params['modelId'] as string))
  })

  router.post(p('/models/:provider/*modelId/ctx/increase'), async (req, res, { params }) => {
    const body = await readJsonBody<{ reason?: string }>(req)
    const result = await deps.increaseCtx(
      params['provider'] as string,
      params['modelId'] as string,
      body.reason
    )
    sendJson(res, 200, result)
  })

  // The chat body's messages (with `tools`, and `chat_template_kwargs` for a measure) in; the count
  // against the session's window, or the compaction to apply with `applyCompaction`, out.
  router.post(p('/models/:provider/*modelId/context/measure'), async (req, res, { params }) => {
    const control = contextControl(deps)
    const request = contextRequestOf(await readJsonBody(req, CONTEXT_BODY_LIMIT))
    if (!request) {
      throw new AtomicCoreError(
        'INVALID_ARGUMENT',
        'A measure needs `messages`: chat messages with a `role` each.'
      )
    }
    sendJson(
      res,
      200,
      await control.measure(params['provider'] as string, params['modelId'] as string, request)
    )
  })

  router.post(p('/models/:provider/*modelId/compact'), async (req, res, { params }) => {
    const control = contextControl(deps)
    const request = compactRequestOf(await readJsonBody(req, CONTEXT_BODY_LIMIT))
    if (!request) {
      throw new AtomicCoreError(
        'INVALID_ARGUMENT',
        'A compaction needs `messages` (chat messages with a `role` each), an integer `reserveTokens` ≥ 0 and a `targetRatio` between 0 and 1 when given.'
      )
    }
    sendJson(
      res,
      200,
      await control.compact(params['provider'] as string, params['modelId'] as string, request)
    )
  })

  router.get(p('/models/:provider/*modelId/capabilities'), async (_req, res, { params }) => {
    sendJson(
      res,
      200,
      await deps.models.capabilities(params['provider'] as string, params['modelId'] as string)
    )
  })

  router.get(p('/models/:provider/*modelId/logs'), async (_req, res, { params }) => {
    const provider = params['provider'] as string
    if (!deps.models.logs) {
      return sendError(
        res,
        new AtomicCoreError('PROVIDER_NOT_FOUND', `The provider "${provider}" keeps no model logs.`, provider)
      )
    }
    sendJson(res, 200, await deps.models.logs(provider, params['modelId'] as string))
  })

  router.post(p('/models/:provider/*modelId/embed'), async (req, res, { params }) => {
    const body = await readJsonBody<{ input?: string[]; ubatch_size?: number }>(req)
    sendJson(
      res,
      200,
      await deps.models.embed(
        params['provider'] as string,
        params['modelId'] as string,
        body.input as string[],
        body.ubatch_size ?? 512
      )
    )
  })

  // Answers `{isValid:false, error}` for a file that is not a model: the user pointed at it, and
  // "that is not a model" is the answer to their question, not a failure of the core.
  router.post(p('/gguf/validate'), async (req, res) => {
    const body = await readJsonBody<{ path?: string }>(req)
    if (!body.path) return sendError(res, new AtomicCoreError('INVALID_ARGUMENT', 'validate needs a path'))
    sendJson(res, 200, await deps.models.validateGguf(body.path))
  })

  // Whether a checkpoint the caller has not downloaded yet would run on a managed provider (spec
  // `managed-model-store`): one route, one shape, every managed engine's own descriptor and memory
  // rule. No network, no filesystem read of any model directory. A provider with no check — not a
  // managed one, or not offered on this platform — is not found.
  router.post(p('/models/:provider/check'), async (req, res, { params }) => {
    const provider = params['provider'] as string
    const check = Object.hasOwn(deps.managedModelChecks ?? {}, provider)
      ? deps.managedModelChecks?.[provider]
      : Object.hasOwn(deps.nativeModelChecks ?? {}, provider)
        ? deps.nativeModelChecks?.[provider]
        : undefined
    if (check === undefined) {
      return sendError(
        res,
        new AtomicCoreError('PROVIDER_NOT_FOUND', `${provider} has no model check in this build.`, provider)
      )
    }
    const body = await readJsonBody(req)
    sendJson(res, 200, await check(body))
  })

  // Where clients put the managed engines' models and how much room is left (spec
  // `managed-model-store`, "Core сообщает расположение хранилища"): on Windows a path into Atomic
  // Chat's WSL distribution, which only core knows. Registered before the deletion route, so a GET here
  // is never read as a model id.
  router.get(p('/managed-models/location'), async (_req, res) => {
    if (!deps.managedModelLocation) {
      return sendError(
        res,
        new AtomicCoreError(
          'PROVIDER_NOT_FOUND',
          'No managed engine is available in this build.',
          'managed-models'
        )
      )
    }
    sendJson(res, 200, await deps.managedModelLocation())
  })

  // Deleting a model of the store (spec "Модель хранилища удаляется через core"): only core knows
  // whether any managed provider has it loaded and owns every engine's caches of it, so clients never
  // remove its folder themselves. The id arrives percent-decoded segment by segment, like every path
  // parameter (change close-cli-core-gaps, design D4: `Qwen%2FQwen3-1.7B` is `Qwen/Qwen3-1.7B`), and is
  // then compared exactly with the ids the store lists, never resolved as a path.
  router.delete(p('/managed-models/*modelId'), async (_req, res, { params }) => {
    if (!deps.managedModelDelete) {
      return sendError(
        res,
        new AtomicCoreError(
          'PROVIDER_NOT_FOUND',
          'No managed engine is available in this build.',
          'managed-models'
        )
      )
    }
    sendJson(res, 200, await deps.managedModelDelete(params['modelId'] as string))
  })

  router.get(p('/runtimes/foundation-models/availability'), async (req, res) => {
    const force = queryOf(req).get('force') === '1'
    const status = deps.foundationModelsAvailability
      ? await deps.foundationModelsAvailability(force)
      : 'unavailable'
    sendJson(res, 200, { status })
  })

  router.get(p('/hardware/devices'), async (req, res) => {
    const provider = queryOf(req).get('provider') ?? 'llamacpp-upstream'
    sendJson(res, 200, { devices: await deps.models.devices(provider) })
  })
}
