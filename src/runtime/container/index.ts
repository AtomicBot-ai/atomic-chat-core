/**
 * The Docker executor (task 2.8, openspec change `add-tensorrt-llm-linux`): pulls, inspects,
 * creates, starts, stops, removes and reads the logs of a model container, and runs one-shot GPU
 * probes. `argv.ts` is pure argv construction; `exec.ts` and `operations.ts` are the injectable I/O
 * that runs it; `pull.ts` talks to the Docker Engine API directly for byte-level pull progress. No
 * shell is ever used, and everything a descriptor or a probe contributed is validated before it
 * becomes an argv token or a URL query value (`argv.ts`'s `assertSafeArgvValue`).
 *
 * `wiring.ts` (task 2.12) is what core startup calls on Linux: it resolves the docker CLI to an
 * absolute system path (`docker-binary.ts`), builds the one executor, and reconciles the journal.
 *
 * `execution-journal.ts` (task 2.10) is the private record of the containers this core instance
 * created; `reconcile.ts` uses it and `operations.ts` to stop and remove what a previous instance
 * left running, and never touches a container that is not in the journal.
 *
 * Public API of this module is exported from this file only.
 */
export * from './types.js'
export * from './argv.js'
export * from './env.js'
export * from './exec.js'
export * from './operations.js'
export * from './pull.js'
export * from './execution-journal.js'
export * from './reconcile.js'
export * from './watchdog.js'
export * from './heartbeat.js'
export * from './docker-binary.js'
export * from './wiring.js'
export * from './wsl-exec.js'
