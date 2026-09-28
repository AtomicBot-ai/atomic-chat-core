/**
 * A containerised text session: launched through an injectable `ManagedDeployment` and published
 * as a desktop `SessionInfo` through a pure projection of its internal `BackendTarget`. Task 2.7
 * (openspec change `add-tensorrt-llm-linux`, ADR `docs/decisions/2026-09-23-preserve-deployment-
 * seams.md`, task T01e) owns the types, the desktop deployment binding, and the projection; the
 * Docker calls that produce a real `EngineLaunchSpec` and `BackendTarget` (task 2.8, `PreparedLaunch`
 * carries the `BackendTarget` the executor resolves — see `docs/decisions/2026-09-28-pull-the-model-
 * image-over-the-docker-engine-api.md`), the session gateway (task 2.11) and the shared lifecycle
 * (task 2.12) build on this module.
 *
 * Public API of this module is exported from this file only.
 */
export * from './types.js'
export * from './backend-target.js'
export * from './mount-source.js'
export * from './deployment.js'
export * from './gateway.js'
