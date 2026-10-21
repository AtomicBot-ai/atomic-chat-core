/**
 * The part of LiteRT-LM's C API (`litert_lm_*`, the binding's ABI 1) the host uses, as an interface.
 * `ffi-bun.ts` implements it over `bun:ffi`; the protocol and server tests (tasks 5.2–5.5) run the host
 * against a fake one. Calls are synchronous except `send`, whose chunks arrive later on the JS thread.
 */

import type { LiteRtLmFileMetadata } from '../../../contracts/index.js'

/** A library call returned an error (the library's own message) or a null handle. */
export class LiteRtLibraryError extends Error {
  constructor(
    readonly operation: string,
    message: string
  ) {
    super(`${operation}: ${message}`)
    this.name = 'LiteRtLibraryError'
  }
}

export type LiteRtBackendName = 'cpu' | 'gpu' | 'npu'
export type LiteRtModality = 'text' | 'vision' | 'audio' | 'video'
export type LiteRtNpuBrand = 'unknown' | 'qualcomm' | 'google-tensor' | 'mediatek' | 'intel' | 'samsung'

/**
 * What `litert_lm_loaded_file_*` tells about a `.litertlm` file without creating an engine: the wire
 * shape core returns from `/models/litert-lm/check`. `max_context_tokens` is `null` when the library
 * answers 0 (not declared); `function_calling` and `thinking` are what the file declares, and Gemma 4
 * files declare neither while doing both (spike S1).
 */
export type LiteRtFileInfo = LiteRtLmFileMetadata

export interface LiteRtEngineSettings {
  model: string
  backend: LiteRtBackendName
  /** Set only for a file with a vision encoder: the engine refuses conversations otherwise (spike S2). */
  visionBackend: LiteRtBackendName | null
  maxNumTokens: number
  /** Must exist (spike S2). */
  cacheDir: string
  /** NPU only: the dispatch library folder of the build. */
  dispatchLibDir?: string
  speculative: boolean
}

/** Always the library's `TOP_P` sampler: `GREEDY` and `TOP_K` are not implemented on CPU (spike S2). */
export interface LiteRtSampler {
  temperature?: number
  topP?: number
  topK?: number
  seed?: number
}

/** One message in the library's conversation JSON (`{role, content: [...], tool_calls?}`). */
export type LiteRtMessage = Record<string, unknown>

export interface LiteRtConversationConfig {
  /** History the conversation starts from; the next `send` continues it. */
  messages: LiteRtMessage[]
  /** OpenAI-shaped `tools`; `null` for none. Fixed for the conversation's life. */
  tools: unknown[] | null
  sampler: LiteRtSampler
  /** Enables the LL_GUIDANCE constraint provider, so a `send` may carry a constraint. */
  constrained: boolean
}

export interface LiteRtSendOptions {
  maxOutputTokens?: number
  constraint?: { kind: 'json_schema' | 'regex'; value: string }
  thinking?: boolean
}

/** A chunk as copied off the library's thread: `text` is one message JSON of the library. */
export interface LiteRtChunk {
  text: string | null
  error: string | null
  final: boolean
}

export interface LiteRtConversation {
  /**
   * Starts a generation; chunks arrive in order on the JS thread, the last one `final` or with an
   * `error` (`CANCELLED…` after `cancel`). Throws when the library refuses to start.
   */
  send(
    message: LiteRtMessage | LiteRtMessage[],
    options: LiteRtSendOptions,
    onChunk: (chunk: LiteRtChunk) => void
  ): void
  /** A cancelled conversation answers every later `send` with `CANCELLED`: drop it (spike S2). */
  cancel(): void
  /** Tokens in the conversation so far, history included. */
  tokenCount(): number
  close(): void
}

export interface LiteRtEngine {
  conversation(config: LiteRtConversationConfig): LiteRtConversation
  close(): void
}

export interface LiteRtLibrary {
  /** The library's version; `null` where it cannot be read (Windows). */
  version: string | null
  /** The binding's ABI number. */
  abi: number
  /** The backends this build can run here: `npu` only with Intel's dispatch library beside it. */
  backends: LiteRtBackendName[]
  inspect(file: string): LiteRtFileInfo
  createEngine(settings: LiteRtEngineSettings): LiteRtEngine
}

export interface LoadLiteRtLibraryOptions {
  /** NPU: the prepared OpenVINO libraries, made findable before the library loads them. */
  ovLibsDir?: string
}

/** Opens the library of one build (`<build>/lib`); throws `LiteRtLibraryError` when it does not load. */
export type LoadLiteRtLibrary = (libDir: string, options?: LoadLiteRtLibraryOptions) => Promise<LiteRtLibrary>

/** The ABI number `ffi-bun.ts` binds; see `SUPPORTED_LITERT_LM_ABI` in engine-builds. */
export const BOUND_LITERT_LM_ABI = 1
