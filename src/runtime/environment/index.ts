/**
 * The managed text-runtime environment: installing, updating and removing the container runtime a
 * text engine needs, as an operation that survives the app closing, the core dying and the machine
 * rebooting (openspec change `add-tensorrt-llm-linux`).
 *
 * `descriptor` reads the metadata that says what to install — the only piece this module has as of
 * task 2.1. The rest (HTTPS fetch and on-disk cache, the transition state machine, the durable
 * store, host recovery, the service that turns a decision into injected external work, host probes)
 * is task 2.2.
 *
 * Public API of this module is exported from this file only.
 */
export * from './descriptor.js'
