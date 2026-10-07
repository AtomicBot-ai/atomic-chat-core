/**
 * Managed engines (change `add-vllm-runtime`, design D3): the registry of engine specs and the one
 * `LocalRuntime` every managed engine is (`ManagedTextRuntime`), over the shared container lifecycle.
 *
 * Public API of this module is exported from this file only.
 */
export * from './spec.js'
export * from './runtime.js'
