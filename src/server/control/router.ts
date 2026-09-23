/**
 * Composes the control route table from its families. Registration order is the matching order
 * (`Router.find` takes the first pattern that fits, e.g. `/settings/status` before
 * `/settings/:provider`), so the calls below must stay in this sequence.
 */

import { CONTROL_API_PREFIX, CONTROL_PROTOCOL_VERSION } from '../../contracts/index.js'
import { Router } from '../http.js'
import { registerBackendRoutes } from './routes/backends.js'
import { registerClientRoutes } from './routes/clients.js'
import { registerCloudRoutes } from './routes/cloud.js'
import { registerDiffusionRoutes } from './routes/diffusion.js'
import { registerDiffusionVideoRoutes } from './routes/diffusion-video.js'
import { registerDiskRoutes } from './routes/disk.js'
import { registerExternalSessionRoutes } from './routes/external-sessions.js'
import { registerHardwareRoutes } from './routes/hardware.js'
import { registerLifecycleRoutes, registerShutdownRoute } from './routes/lifecycle.js'
import { registerModelRoutes } from './routes/models.js'
import { registerPublicServerRoutes } from './routes/public-server.js'
import { registerRemoteAccessRoutes } from './routes/remote-access.js'
import { registerSettingsRoutes } from './routes/settings.js'
import { registerTelemetryRoutes } from './routes/telemetry.js'
import type { ControlServer } from './server.js'
import type { ControlRouteContext, ControlServerDeps, ControlSnapshot } from './types.js'

export function buildRouter(deps: ControlServerDeps, self: () => ControlServer | undefined): Router {
  const now = deps.now ?? Date.now
  const startedAt = deps.startedAt ?? now()
  const p = (suffix: string) => `${CONTROL_API_PREFIX}${suffix}`
  const snapshot = (): ControlSnapshot => ({
    instance_id: deps.instanceId,
    owner_scope: deps.ownerScope,
    protocol: CONTROL_PROTOCOL_VERSION,
    version: deps.version,
    pid: process.pid,
    data_folder: deps.dataFolder,
    started_at: startedAt,
    uptime_ms: now() - startedAt,
    cursor: deps.emitter.cursor(),
    sessions: deps.sessions(),
    server: deps.publicServer.status(),
    clients: deps.clients.list(),
    downloads: [],
    optimal_backends: deps.backends.optimalSnapshot(),
  })
  const ctx: ControlRouteContext = { p, now, startedAt, snapshot, self }

  const router = new Router()

  registerLifecycleRoutes(router, deps, ctx)
  registerClientRoutes(router, deps, ctx)
  registerModelRoutes(router, deps, ctx)
  registerBackendRoutes(router, deps, ctx)
  registerHardwareRoutes(router, deps, ctx)
  registerDiskRoutes(router, deps, ctx)
  registerSettingsRoutes(router, deps, ctx)
  registerExternalSessionRoutes(router, deps, ctx)
  registerCloudRoutes(router, deps, ctx)
  registerPublicServerRoutes(router, deps, ctx)
  registerRemoteAccessRoutes(router, deps, ctx)
  registerDiffusionRoutes(router, deps, ctx)
  registerDiffusionVideoRoutes(router, deps, ctx)
  registerTelemetryRoutes(router, deps, ctx)
  registerShutdownRoute(router, deps, ctx)

  return router
}
