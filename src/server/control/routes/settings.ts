/** Provider settings: status, read, patch, import from the app, acknowledge. */

import { AtomicCoreError } from '../../../contracts/index.js'
import type { LocalProviderId } from '../../../contracts/index.js'
import { LOCAL_PROVIDER_IDS } from '../../../settings/index.js'
import type { ImportOptions, ProviderValues } from '../../../settings/index.js'
import { readJsonBody, sendError, sendJson } from '../../http.js'
import type { Router } from '../../http.js'
import type { ControlRouteContext, ControlServerDeps } from '../types.js'

export function registerSettingsRoutes(
  router: Router,
  deps: ControlServerDeps,
  ctx: ControlRouteContext
): void {
  const { p } = ctx

  // Whether a provider's settings have been handed over, and whether the app has confirmed it saw
  // the result. The migration flag must not be turned on for a scope that has not reached
  // `migrated` — the core would load with its own defaults instead of the user's (PLAN.md §3.4).
  router.get(p('/settings/status'), (_req, res) => {
    const scopes: Record<string, unknown> = {}
    for (const provider of LOCAL_PROVIDER_IDS) {
      const migration = deps.settings.migration(provider)
      scopes[provider] = {
        migrated: migration?.legacy_hash != null,
        acknowledged_revision: migration?.acknowledged_revision ?? null,
        // True once the app has confirmed it mirrored everything the core currently holds; a
        // planned rollback needs this before handing ownership back.
        in_sync:
          migration?.acknowledged_revision != null &&
          migration.acknowledged_revision === deps.settings.revision(),
      }
    }
    sendJson(res, 200, { revision: deps.settings.revision(), scopes })
  })

  router.get(p('/settings/:provider'), (_req, res, { params }) => {
    const provider = params['provider'] as LocalProviderId
    sendJson(res, 200, {
      provider,
      revision: deps.settings.revision(),
      values: deps.settings.get(provider),
      migration: deps.settings.migration(provider),
    })
  })

  router.patch(p('/settings/:provider'), async (req, res, { params }) => {
    const body = await readJsonBody<{ values?: ProviderValues; expected_revision?: number }>(req)
    const result = await deps.settings.update(params['provider'] as LocalProviderId, body.values ?? {}, {
      ...(typeof body.expected_revision === 'number' ? { expectedRevision: body.expected_revision } : {}),
    })
    sendJson(res, 200, result)
  })

  // Hand the app's own settings over (PLAN.md §3.4). Answers 409 on a conflict, because the caller
  // has to put the choice to the user before this scope can be migrated at all.
  router.post(p('/settings/:provider/import'), async (req, res, { params }) => {
    const body = await readJsonBody<{
      values?: ProviderValues
      resolutions?: ImportOptions['resolutions']
      expected_revision?: number
    }>(req)
    const result = await deps.settings.importProvider(
      params['provider'] as LocalProviderId,
      body.values ?? {},
      {
        ...(body.resolutions ? { resolutions: body.resolutions } : {}),
        ...(typeof body.expected_revision === 'number' ? { expectedRevision: body.expected_revision } : {}),
      }
    )
    sendJson(res, result.status === 'conflict' ? 409 : 200, result)
  })

  router.post(p('/settings/:scope/acknowledge'), async (req, res, { params }) => {
    const body = await readJsonBody<{ revision?: number }>(req)
    if (typeof body.revision !== 'number')
      return sendError(
        res,
        new AtomicCoreError('INVALID_ARGUMENT', 'acknowledge needs the revision being confirmed')
      )
    sendJson(res, 200, await deps.settings.acknowledge(params['scope'] as string, body.revision))
  })
}
