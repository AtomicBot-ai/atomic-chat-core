/**
 * The `foundry-local` provider (openspec change `add-foundry-local`): the core's side of the
 * `foundry-host` protocol for now; the runtime, the host mode and the accelerators follow.
 */
export * from './host-process.js'
export * from './model-yml.js'
export { runFoundryHost, loadLibraryWithBun } from './host/run.js'
export type { FoundryHostDeps } from './host/run.js'
