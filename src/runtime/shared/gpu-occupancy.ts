/**
 * What every local engine tells core about the GPUs it holds (spec `gpu-residency`, design D10), so
 * one residency rule can run over all of them: llama.cpp, MLX, `tensorrt-llm` and diffusion report
 * their sessions in this shape, and ask core before a load starts through a `GpuClaimHook`.
 *
 * Types only: the rule itself is `core/gpu`'s, and the I/O it needs (unloading another engine's
 * session) is core's wiring. A runtime never decides another runtime's fate.
 */

/**
 * The GPUs a session holds: every card (`'all'`: llama.cpp and MLX chat, diffusion — they spread a
 * model over whatever the machine has), the listed card ids (`tensorrt-llm`: its one chosen card), or
 * none (`[]`: a CPU-only session).
 */
export type GpuCards = 'all' | readonly string[]

/**
 * `loading`: its claim succeeded and it is starting. `stopping`: a stop is in flight.
 * `stop-unconfirmed`: a stop nobody could confirm — the cards are still held.
 */
export type GpuOccupancyState = 'loading' | 'ready' | 'stopping' | 'stop-unconfirmed'

/** One session of a runtime, as GPU residency sees it. */
export interface GpuOccupancy {
  model_id: string
  cards: GpuCards
  /**
   * An embedding or transcription session: residency never evicts it, and loading it never evicts
   * anything (spec "Вспомогательные модели не участвуют в вытеснении").
   */
  auxiliary: boolean
  state: GpuOccupancyState
  /** What the user can do when this session will not stop (a `GPU_BUSY` names it); a default otherwise. */
  remedy?: string
}

/** What a load is about to take, asked of core before anything is started. */
export interface GpuClaim {
  model_id: string
  cards: GpuCards
  auxiliary: boolean
  /**
   * The provider runs one session at a time (`tensorrt-llm`, a runtime limit rather than a residency
   * rule, design D10): its other sessions go too, on whichever card they are.
   */
  soleSessionOfProvider?: boolean
}

/**
 * Core's answer to a claim: resolves once everything else on those cards is confirmed gone, rejects
 * with `GPU_BUSY` (a stop nobody could confirm) or `MODEL_LOAD_CANCELLED` (`signal` aborted while
 * waiting). The runtime starts nothing before it resolves.
 *
 * `granted` is called synchronously, inside core's turn, the moment the claim succeeds: that is where
 * the runtime starts reporting the load as `loading`, so the next claim — which cannot run before this
 * turn ends — always sees it. A runtime with no hook registers the load itself.
 */
export type GpuClaimHook = (claim: GpuClaim, signal?: AbortSignal, granted?: () => void) => Promise<void>
