/**
 * Whether a TensorRT-LLM launch captures CUDA graphs, in one module the launch (`adapter.ts`), its
 * plan and the memory check (`compatibility.ts`) all import: the graphs cost memory the check has to
 * count, and `auto` has to know whether that memory is there.
 */

/** Below this much card memory `cuda_graphs: auto` leaves CUDA graphs off: they took about 2 GB on
 *  an 8 GB card in the Windows live acceptance (Qwen3.5-2B, "Memory used outside torch … 2.12 GiB").
 *  A card that reports no size of its own is a unified-memory one (GB10): it keeps them. */
export const TENSORRT_LLM_CUDA_GRAPHS_MIN_VRAM_BYTES = 12 * 1024 ** 3

/**
 * What capturing CUDA graphs adds to the engine's peak, beyond what the memory check already counts.
 * NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4 on the RTX 5090 Laptop (2026-10-09): 21.47 GiB peak
 * with graphs off, 26.37 GiB with them on (5.15 GiB outside torch instead of 1.92, 2.57 GiB of
 * activations instead of 1.32), and every request then failed with "CUDA out of memory … 0 bytes is
 * free". About 2 GB on an 8 GB card (Qwen3.5-2B). The larger figure, rounded up: too much only turns
 * graphs off where they would have fit, too little starts a model that cannot answer.
 */
export const TENSORRT_LLM_CUDA_GRAPHS_RESERVE_BYTES = 5 * 1024 ** 3

export type TensorrtLlmCudaGraphsSetting = 'auto' | 'on' | 'off'

/** What `beforeCreate` hands the TensorRT-LLM launch (`ManagedLaunchContext.plan`), from the card as
 *  it stands right before the container is created. */
export interface TensorrtLlmLaunchPlan {
  cudaGraphs: boolean
}

/**
 * Whether the launch captures CUDA graphs. `on` and `off` are the user's. `auto` turns them on only on
 * a card of at least `TENSORRT_LLM_CUDA_GRAPHS_MIN_VRAM_BYTES` (or a unified-memory one, `vramBytes`
 * null) — and, when the free memory left after everything else the check counts is known
 * (`headroomBytes`), only when the graphs fit in it: a 24 GB card holding an 18 GiB model has the size
 * but not the room.
 */
export function tensorrtLlmCudaGraphsOn(
  setting: TensorrtLlmCudaGraphsSetting,
  vramBytes: number | null,
  headroomBytes?: number
): boolean {
  if (setting !== 'auto') return setting === 'on'
  if (vramBytes !== null && vramBytes < TENSORRT_LLM_CUDA_GRAPHS_MIN_VRAM_BYTES) return false
  return headroomBytes === undefined || headroomBytes >= TENSORRT_LLM_CUDA_GRAPHS_RESERVE_BYTES
}
