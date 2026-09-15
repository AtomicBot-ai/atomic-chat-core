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
export * from './cuda-family.js'
export * from './archive.js'
export * from './manifest.js'
export * from './bundled-manifest-baseline.js'
export * from './amd-rocm-pci-ids.js'
export * from './select.js'
export * from './migrate.js'
export * from './installed.js'
export * from './optimal-cache.js'
export * from './scan.js'
