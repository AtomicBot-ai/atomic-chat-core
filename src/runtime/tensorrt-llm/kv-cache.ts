/**
 * The KV-cache numbers the launch (`adapter.ts`) and the memory check (`compatibility.ts`) must agree
 * on, in one module both import: the pure policy never reaches into the adapter (and through it the
 * managed-text lifecycle) for a constant.
 */

/** The one default KV-cache fraction: the launch passes it (`adapter.ts`'s `buildTensorrtLlmLaunch`, through the validated settings), the model check
 *  and the pre-launch check size their reserve with it (`compatibility.ts`'s `kvCacheReserveBytes`,
 *  through the same validated settings), and `src/settings/schema/tensorrt-llm.json` stores it
 *  (pinned equal by `settings.test.ts`). Below `trtllm-serve`'s own 0.9 on purpose: at 0.9 an 8 GB
 *  card ran out of memory on the engine's non-KV allocations after the KV cache took its share
 *  (budget table `_no_capture_init_kv_cache: 3.50 / 0.35`); 0.85 failed too, 0.8 loaded (docs/decisions/2026-09-29-tensorrt-llm-kv-cache-fraction-0-8-and-oom-read-from-the-whole-log.md). */
export const TENSORRT_LLM_DEFAULT_KV_CACHE_FREE_FRACTION = 0.8

/**
 * How many full contexts the KV cache holds on a unified-memory card: one full-context request plus
 * a concurrent one. A starting value, not a measurement (docs/decisions/2026-09-29-tensorrt-llm-
 * unified-memory-kv-cache-bounded-by-tokens.md).
 */
export const TENSORRT_LLM_UNIFIED_KV_CONTEXTS = 2

/**
 * The `kv_cache_config.max_tokens` a unified-memory launch writes, and the token count its memory
 * check reserves KV for. On a unified-memory card (GB10/DGX Spark) "free GPU memory" is the system's
 * free RAM, so `--kv_cache_free_gpu_memory_fraction` alone would hand most of the machine's memory to
 * the KV cache whatever the context length; this bounds it to what the configured context needs.
 */
export function tensorrtLlmUnifiedKvMaxTokens(contextLength: number): number {
  return contextLength * TENSORRT_LLM_UNIFIED_KV_CONTEXTS
}
