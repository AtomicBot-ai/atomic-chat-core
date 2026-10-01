/**
 * The managed text-runtime environment: installing, updating and removing the container runtime a
 * text engine needs, as an operation that survives the app closing, the core dying and the machine
 * rebooting (openspec change `add-tensorrt-llm-linux`).
 *
 * The pieces, in the order a setup goes through them: `descriptor` reads the metadata that says
 * what to install, `descriptor-provider` gets it from conf (or an override) over HTTPS, caches it by
 * `descriptor_id`, applies the version gate, and pins an installation to the one it was set up with
 * (task 2.3), `environment-manifest` and `environment-manifest-provider` do the same for the Linux
 * environment manifest — the install recipe's qualified distributions, kept apart from any engine
 * (change `extract-environment-manifest`) — over the mechanism both share (`cached-document`,
 * `document-fields`), `canonical-json` hashes what consent and idempotency are decided on, `state` is
 * the transition table, `store` keeps the record across restarts under a lock two cores respect,
 * `recovery` reconciles a record against what the machine actually shows, and `service` turns each
 * decision into one piece of injected external work. `host-exec` runs a read-only probe command for
 * real; `linux-probe` and `windows-probe` are the pure assessments built on top of it — `wiring`
 * only ever selects the Linux one (task 2.2): Windows is a non-goal of this change, so
 * `windows-probe` is ported and tested but never registered. `linux-provisioner` is the Linux host
 * recipe the service runs a setup and a removal through (task 2.6), over `linux-host` (the real
 * machine, or the e2e test host) and `installations` (the records both scopes share). `inventory`
 * is the one piece of the model-compatibility check (spec `tensorrt-llm-models`) that belongs
 * here: the digest that pins a curated model's file listing.
 *
 * Public API of this module is exported from this file only.
 */
export * from './canonical-json.js'
export * from './descriptor.js'
export * from './descriptor-provider.js'
export * from './environment-manifest.js'
export * from './environment-manifest-provider.js'
export * from './cached-document.js'
export * from './host-exec.js'
export * from './inventory.js'
export * from './linux-docker-facts.js'
export * from './linux-plan.js'
export * from './linux-probe.js'
export * from './recovery.js'
export * from './service.js'
export * from './state.js'
export * from './store.js'
export * from './wiring.js'
export * from './windows-probe.js'
export * from './installations.js'
export * from './linux-host.js'
export * from './linux-provisioner.js'
export * from './guest-host.js'
export * from './provisioner-descriptors.js'
export * from './windows-environment-record.js'
export * from './windows-host.js'
export * from './windows-plan.js'
export * from './windows-provisioner.js'
export * from './windows-guest-setup.js'
export * from './rootfs-download.js'
