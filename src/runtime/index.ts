/**
 * Process mechanics shared by every local backend: environment (library/CUDA paths), path
 * validation, ports and API keys, spawn/readiness/termination. `llamacpp/`, `mlx/` and
 * `foundation-models/` build on it.
 *
 * Ported from: tauri-plugin-llamacpp-upstream/src/{commands,process,path}.rs, utils/src/{system,network}.rs.
 * See PLAN.md §3.2.
 */
export * from './env.js'
export * from './paths.js'
export * from './ports.js'
export * from './process.js'
