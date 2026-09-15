/**
 * MTP / DFlash / EAGLE-3 draft registries, transcription model constants, chat-template overrides.
 *
 * Ported verbatim from: extensions/llamacpp-upstream-extension/src/{dflashRegistry,gemmaMtpRegistry,
 * transcriptionRegistry,chatTemplateOverrides}.ts and extensions/mlx-extension/src/{dflashRegistry,
 * eagle3Registry,mtpRegistry}.ts. Every file is pure (static tables + predicates); nothing here does I/O.
 *
 * Both DFlash registries export a `resolveDflashDraft`; the llama.cpp one keeps its name and the MLX
 * one is re-exported as `resolveMlxDflashDraft` (the file itself keeps the app's name).
 * See PLAN.md §3.2. Public API of this module is exported from this file only.
 */
export * from './dflash-registry.js'
export * from './gemma-mtp-registry.js'
export * from './transcription-registry.js'
export * from './chat-template-overrides.js'
export {
  STATIC_DRAFT_MAP,
  normalizeBaseId,
  resolveDflashDraft as resolveMlxDflashDraft,
  type DraftRepoManifest,
  type DraftResolution,
} from './mlx-dflash-registry.js'
export * from './mlx-eagle3-registry.js'
export * from './mlx-mtp-registry.js'
