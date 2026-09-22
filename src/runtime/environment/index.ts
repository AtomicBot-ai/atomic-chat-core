/**
 * The managed text-runtime environment: installing, updating and removing the container runtime a
 * text engine needs, as an operation that survives the app closing, the core dying and the machine
 * rebooting.
 *
 * The pieces, in the order a setup goes through them: `descriptor` reads the metadata that says
 * what to install, `canonical-json` hashes what consent and idempotency are decided on, `state` is
 * the transition table, `store` keeps the record across restarts under a lock two cores respect,
 * `recovery` reconciles a record against what the machine actually shows, and `service` turns each
 * decision into one piece of injected external work. The host recipes themselves live beside this
 * module, behind the provisioner seam.
 *
 * Public API of this module is exported from this file only.
 */
export * from './canonical-json.js'
export * from './descriptor.js'
export * from './linux-probe.js'
export * from './recovery.js'
export * from './service.js'
export * from './state.js'
export * from './store.js'
export * from './wiring.js'
export * from './windows-probe.js'
