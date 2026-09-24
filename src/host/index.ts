/**
 * Host entry (`atomic-chat-core/host`): what a program that *runs* the core needs beyond the
 * `AtomicCore` facade. A host owns a data folder, finds or starts the daemon that owns it, reads the
 * lock and the control token, and reports its own crashes — the CLI in `src/cli/` does exactly this,
 * and an external host (the `atc` server CLI) must do it the same way rather than re-implement the
 * lock semantics.
 *
 * Node-only, unlike `./client` and `./contracts`. Nothing here is new behaviour: every symbol is
 * the public API of a module that already existed; this file only makes it reachable from outside
 * the package.
 */
export * from '../config/index.js'
export * from '../lock/index.js'
export * from '../cli/index.js'
export * from '../telemetry/index.js'
