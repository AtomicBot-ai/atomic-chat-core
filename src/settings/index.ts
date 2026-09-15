/**
 * `<data>/atomic-core/settings.json` store and the provider setting schemas.
 *
 * Ported from: core/src/browser/extension.ts:150-240 (descriptor arrays in localStorage),
 * extensions/<ext>/settings.json (embedded verbatim under `schema/`), extensions/llamacpp-upstream-extension/
 * src/index.ts:697-745 (settings → `this.config`). Legacy localStorage import is a later phase.
 * See PLAN.md §3.2 / §3.4. Public API of this module is exported from this file only.
 */
export * from './schema.js'
export * from './store.js'
