/**
 * The part of GenieX's C API (`geniex.h` of v0.9.3, the binding's ABI 1) the host uses, as an
 * interface the Worker calls synchronously. `ffi-bun.ts` implements it over `bun:ffi`; the protocol
 * and server tests (tasks 5.2–5.5) run against a fake one. Every call blocks the calling thread —
 * `generate` for the whole answer, calling `onToken` from inside — which is why the Worker, not the
 * host's main thread, owns the library (design D1).
 */

import type { GeniexDevice, GeniexPlugin } from '../../../contracts/index.js'

/** A library call returned an error code (the library's own message) or a null handle. */
export class GeniexLibraryError extends Error {
  constructor(
    readonly operation: string,
    message: string,
    /** `geniex_ErrorCode` when the call returned one. */
    readonly code: number | null = null
  ) {
    super(`${operation}: ${message}`)
    this.name = 'GeniexLibraryError'
  }
}

/** `GENIEX_ERROR_COMMON_CANCELLED`: the token callback returned `false`. */
export const GENIEX_CANCELLED = -100006

/** `geniex_PowerMode`, in the library's order: the index is the enum value. */
export const GENIEX_POWER_MODES = [
  'low_power_saver',
  'power_saver',
  'high_power_saver',
  'low_balanced',
  'balanced',
  'high_performance',
  'sustained_high_performance',
  'burst',
] as const
export type GeniexPowerMode = (typeof GENIEX_POWER_MODES)[number]

/** One part of a message's content: text, or an image the library reads from a file. */
export type GeniexContent = { type: 'text'; text: string } | { type: 'image'; path: string }

/** One message of `apply_chat_template` (`geniex_LlmChatMessage` / `geniex_VlmChatMessage`). */
export interface GeniexChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: GeniexContent[]
  /** `assistant`: the calls it issued this turn. */
  tool_calls?: Array<{ id: string | null; name: string; arguments: string }>
  /** `tool`: which call this answers. */
  tool_call_id?: string | null
  tool_name?: string | null
}

export interface GeniexTemplateInput {
  messages: GeniexChatMessage[]
  /** OpenAI-shaped `tools` as one JSON string; `null` for none. */
  tools: string | null
  enableThinking: boolean
}

/** `geniex_SamplerConfig` without the paths; `null` fields keep the plugin's defaults. */
export interface GeniexSampler {
  temperature?: number
  topP?: number
  topK?: number
  seed?: number
  /** llama.cpp GBNF; `null` for none. */
  grammar: string | null
}

export interface GeniexGenerationConfig {
  maxTokens: number
  stop: string[]
  sampler: GeniexSampler
  /** VLM only: the images of this turn, in the order the content names them. */
  imagePaths: string[]
}

/** `geniex_ProfileData.stop_reason`, plus `cancelled` for a callback that said stop. */
export type GeniexStopReason =
  'eos' | 'length' | 'user' | 'stop_sequence' | 'context_length' | 'cancelled' | 'unknown'

export interface GeniexGenerateResult {
  stopReason: GeniexStopReason
  promptTokens: number
  generatedTokens: number
}

export interface GeniexModelSettings {
  plugin: GeniexPlugin
  /** The alias the library resolves (`geniex_resolve_device`). */
  device: GeniexDevice
  /** A GGUF file, or an AI Hub bundle folder. */
  model: string
  /** `llama_cpp` only: creates a VLM instead of an LLM. */
  mmproj: string | null
  nCtx: number
  powerMode: GeniexPowerMode
}

export interface GeniexModel {
  /** Created with a vision projector: takes images. */
  readonly vision: boolean
  applyChatTemplate(input: GeniexTemplateInput): string
  /**
   * The whole generation, blocking; `onToken` runs for each token in this thread and ends the
   * generation by returning `false` (the library answers `cancelled`). Throws `GeniexLibraryError`
   * for anything but a clean end or a cancel.
   */
  generate(
    prompt: string,
    config: GeniexGenerationConfig,
    onToken: (token: string) => boolean
  ): GeniexGenerateResult
  destroy(): void
}

export interface GeniexLibrary {
  /** `geniex_version()`; `null` where it cannot be read. */
  version: string | null
  /** The binding's ABI number. */
  abi: number
  /** `geniex_get_plugin_list`. */
  plugins(): string[]
  /** `geniex_get_device_list` of one plugin: device ids (`HTP0`, `GPUOpenCL`, `CPU`). */
  devices(plugin: string): string[]
  createModel(settings: GeniexModelSettings): GeniexModel
  /** `geniex_deinit`. */
  close(): void
}

/** Opens the library of one build (`<build>/lib`); throws `GeniexLibraryError` when it does not load. */
export type LoadGeniexLibrary = (libDir: string) => Promise<GeniexLibrary>

/** The ABI number `ffi-bun.ts` binds; see `SUPPORTED_GENIEX_ABI` in engine-builds. */
export const BOUND_GENIEX_ABI = 1

/** The plugin whose devices `probe` reports: the GGUF one, which lists the NPU, the GPU and the CPU. */
export const PROBE_PLUGIN = 'llama_cpp'
