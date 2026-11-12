/**
 * The `foundry-local` provider (openspec change `add-foundry-local`): the core's side of the
 * `foundry-host` protocol, the runtime over it, and the accelerator compatibility check the model
 * catalog shows.
 */
export * from './host-process.js'
export * from './model-yml.js'
export type { FoundryHostDeps } from './host/run.js'
export * from './runtime.js'
export * from './accelerators.js'
export * from './check.js'
