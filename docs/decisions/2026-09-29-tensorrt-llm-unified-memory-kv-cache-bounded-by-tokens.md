---
date: 2026-09-29
title: "tensorrt-llm: on a unified-memory card the KV cache is bounded by tokens, and the memory check reserves exactly that"
---

# 2026-09-29 — tensorrt-llm: on a unified-memory card the KV cache is bounded by tokens, and the memory check reserves exactly that

- **Context:** The core launches `trtllm-serve` with `--kv_cache_free_gpu_memory_fraction 0.8` (record
  `2026-09-29-tensorrt-llm-kv-cache-fraction-0-8-and-oom-read-from-the-whole-log.md`). On a discrete card
  that is a share of the card's own free VRAM, and it is live-verified. A unified-memory card (GB10 / DGX
  Spark) has no VRAM of its own. Captured on a DGX Spark-class host, `nvidia-smi` reports `[N/A]` for
  `memory.total` and `memory.free`, `nvidia-smi -q` reports `Addressing Mode : ATS` and `N/A` for every
  framebuffer figure, and `/proc/meminfo` shows 121.7 GiB total. There, "free GPU memory" is the
  system's free RAM, so the fraction alone makes TRT-LLM reserve about 80% of the machine's free memory
  for the KV cache, whatever the context length. That is tens of GB on a 128 GB Spark, taken from the
  desktop and the OS. The memory check had the matching gap: on a unified-memory card it compared
  `weights + KV(context) / fraction` with `MemAvailable` (design D13), a number that says nothing about
  what the launch would actually take.
- **Decision:** (controller ruling)
  1. When the target card is unified memory (`GpuFacts.total_vram_bytes === null`, the same test the
     check already used for `unified_memory`), the launch writes
     `kv_cache_config: {max_tokens: N}` into the per-generation `llm-api-options.yaml` the adapter already
     writes. `N = context_length × 2` (`tensorrtLlmUnifiedKvMaxTokens`,
     `TENSORRT_LLM_UNIFIED_KV_CONTEXTS = 2`): room for one full-context request plus a concurrent one.
     This is a **starting value**, not a measurement. When the family also declares structured output,
     the two keys share the file (`guided_decoding_backend: xgrammar` first). When only the bound
     applies, the file holds only `kv_cache_config`, and the argv gains `--extra_llm_api_options` for it.
  2. The fraction flag stays in the argv as the upper bound. TensorRT-LLM 1.2.1 uses the smaller of
     the two. `tensorrt_llm/llmapi/llm_args.py` `KvCacheConfig.max_tokens` (line 1636) says: "If both
     `max_tokens` and `free_gpu_memory_fraction` are specified, memory corresponding to the minimum
     will be used." The YAML does not drop the flag. `commands/serve.py` `get_llm_args` builds
     `KvCacheConfig(free_gpu_memory_fraction=...)` from the flag (line 125), and
     `update_llm_args_with_extra_dict` (`llm_args.py` line 3312) deep-merges a YAML `kv_cache_config`
     over it as `model_dump(exclude_unset=True) | yaml`. Checked against the 1.2.1 source copy used
     for this change, not on hardware.
  3. On a unified-memory card the memory check (`/models/tensorrt-llm/check` and the pre-launch
     `beforeCreate` check) reserves `weights + KV_bytes(N tokens)`, with no division by the fraction,
     against `MemAvailable`. `KV_bytes` uses the same per-token formula as before
     (`kvCacheReserveBytes(..., unifiedMemory)`). The fallback for a `config.json` with no KV shape,
     `weights × (1 − fraction)`, is the same on both kinds of card. A refusal's details name
     `kv_max_tokens=N`. `fits_other_gpus` measures each card by its own rule.
  4. Discrete cards are unchanged: no token bound, and the reserve stays `KV_bytes(context) / fraction`.
- **Consequences:**
  - On a Spark the KV cache no longer grows with free RAM. It is at most N tokens' worth (about 5.4 GB
    for a Llama-3.3-70B bf16 KV at context 8192) instead of about 80% of free memory. The memory check
    and the launch now describe the same cache.
  - With `N = 2 × context` a single request always fits the cache. Throughput from more than two
    concurrent full-context requests is capped by design. Raising `TENSORRT_LLM_UNIFIED_KV_CONTEXTS`
    is the lever if a live Spark run shows the bound is too tight.
  - Not verified on hardware: whether `cudaMemGetInfo` on GB10 counts the page cache as free. If it
    does not, the fraction bound can come out smaller than N tokens right after the weights are read
    from disk, and the engine then gets a smaller cache than the check reserved. That is safe for the
    host but could refuse a full-context request. A live GB10 run is the check.
  - The restart key is unchanged. N derives from `context_length`, which is already in it, and the
    card, which decides unified memory, is already part of the lifecycle's load key.
  - Amends the unified-memory branch of
    `2026-09-29-tensorrt-llm-kv-reserve-is-the-real-formula-and-memory-is-checked-after-eviction.md`.
    Discrete cards keep that record's formula.
- **Owner:** `team`
- **Links:** `src/runtime/tensorrt-llm/adapter.ts` (`tensorrtLlmUnifiedKvMaxTokens`,
  `buildTensorrtLlmLaunch`), `src/runtime/tensorrt-llm/compatibility.ts` (`kvCacheReserveBytes`,
  `checkModelMemory`), `src/runtime/managed-text/adapter.ts` (`ManagedLaunchContext.unifiedMemory`),
  `src/runtime/tensorrt-llm/runtime.ts`; tests in `adapter.test.ts`, `compatibility.test.ts`,
  `runtime.test.ts`, `../managed-text/lifecycle.test.ts`; fixtures `test/fixtures/linux-probe/nvidia-smi/gb10-driver595-captured.csv`,
  `test/fixtures/linux-probe/meminfo/gb10-captured-head.txt`.
