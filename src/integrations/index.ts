/**
 * Coding-agent integrations: the catalog `launch` works from, and the config writers that point an
 * agent at a local model. Ported from `src-tauri/src/core/cli/integrations.rs` and the
 * `configure_*` commands in `src-tauri/src/core/system/commands.rs` (PLAN.md §4, phase 2).
 */
export * from './catalog.js'
export * from './detect.js'
export * from './config-io.js'
export * from './configure/index.js'
