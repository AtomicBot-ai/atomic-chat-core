/**
 * Data-folder resolution and on-disk layout (DataLayout, ProviderPaths, backend exe candidates).
 *
 * Ported from: src-tauri/src/core/app/{commands,models,constants}.rs,
 * extensions/llamacpp-upstream-extension/src/{index,backend}.ts (getProviderPath/getModelsRootPath/getBackendExePath).
 * See PLAN.md §3.2. Public API of this module is exported from this file only.
 */
export * from './data-folder.js'
export * from './paths.js'
