/**
 * Image generation on stable-diffusion.cpp: one resident `sd-server`, jobs against its
 * `/sdcpp/v1/*` API, step progress read from its output, and the gallery on disk. A module of its
 * own, not a local runtime (ADR 2026-09-17-image-generation-is-its-own-module-not-a-local-runtime).
 *
 * Ported from: src-tauri/plugins/tauri-plugin-atomic-diffusion/src/ at app commit `ec1fd3ea7`.
 */
export * from './args.js'
export * from './compat.js'
export * from './containment.js'
export * from './errors.js'
export * from './gallery.js'
export * from './http.js'
export * from './idle.js'
export * from './image-job.js'
export * from './install.js'
export * from './job-kind.js'
export * from './jobs.js'
export * from './mutex.js'
export * from './parse.js'
export * from './png.js'
export * from './progress.js'
export * from './recipe.js'
export * from './server-process.js'
export * from './service.js'
export * from './session.js'
export * from './state.js'
export * from './tracker.js'
export * from './types.js'
export * from './validate.js'
export * from './wiring.js'
export * from './workflow.js'
