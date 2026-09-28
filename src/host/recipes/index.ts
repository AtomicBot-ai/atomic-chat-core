/**
 * Privileged host recipes and the executor that runs them (design D2/D3). `linux.install-container-
 * runtime` is the only recipe: pure step builders in `install-container-runtime.ts`, the request and
 * result file protocol in `request-file.ts`, the run itself in `executor.ts` over injected I/O, and
 * the real I/O for a root process in `executor-io.ts`. Both the core binary (`host-step exec`) and
 * `atc host-step exec` call `executeHostStep` from here, through `@atomic-chat/core/host`.
 *
 * Public API of this module is exported from this file only.
 */
export * from './install-container-runtime.js'
export * from './request-file.js'
export * from './executor.js'
export * from './executor-io.js'
