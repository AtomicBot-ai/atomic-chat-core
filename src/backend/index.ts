/**
 * Backend packs: manifest + URL resolution, hardware tier selection, id migration, installed-pack
 * helpers and the optimal-backend cache. Pure policy only — downloads, extraction, directory scans
 * and `--list-devices` spawning are phase 1 and live in `downloads/` and `runtime/`.
 *
 * Ported from: extensions/llamacpp-upstream-extension/src/backend.ts, bundledManifestBaseline.ts,
 * index.ts (optimal cache, configureBackends decisions, tier probing), scripts/resolve-upstream-backend.mjs,
 * tauri-plugin-llamacpp-upstream/src/{backend,amd_rocm_pci_ids}.rs.
 * See PLAN.md §3.2. Public API of this module is exported from this file only.
 */
export * from './types.js'
export * from './version.js'
export * from './catalog/index.js'
export * from './select/index.js'
export * from './optimal/index.js'
export * from './installed/index.js'
export * from './turboquant.js'
export * from './install/index.js'
