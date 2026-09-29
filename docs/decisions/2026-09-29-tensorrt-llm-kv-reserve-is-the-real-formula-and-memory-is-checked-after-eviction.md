---
date: 2026-09-29
title: "tensorrt-llm: the KV-cache reserve uses the real per-token formula, and memory is checked only after eviction"
---

# 2026-09-29 — tensorrt-llm: the KV-cache reserve uses the real per-token formula, and memory is checked only after eviction

- **Context:** Two records this same day (`2026-09-29-tensorrt-llm-model-check-kv-reserve-uses-the-
  configured-fraction.md` and the 2026-09-28 record it superseded) built the KV-cache reserve as a
  fraction of the checkpoint's own weight bytes — `weights × (1 − kv_cache_free_gpu_memory_fraction)`
  — because nothing in the check had a context length or the checkpoint's own attention-head shape to
  size a real KV cache from. Review round 1 of the wiring task (findings-2.16w-r1.md) ruled that
  `config.json` in fact carries everything the real formula needs (`num_hidden_layers`,
  `num_key_value_heads`/`num_attention_heads`, `head_dim`/`hidden_size`), and that a context length is
  now available too (stored provider settings, a load's own overrides, or the adapter's default) — so
  the weight-proportional rule no longer has to be the only option (finding 6, RULING).
  Separately (finding 1, Critical), review found that the *whole* memory check — files, architecture,
  format, compute capability and the KV reserve together — ran before `stopPrevious` evicted whatever
  model the new load was replacing. On a single-GPU host, or under task 2.15's cross-provider GPU
  residency, that means switching from model A to model B was refused whenever A's own footprint left
  too little free memory for B to pass the check *while A was still resident* — even though the
  lifecycle was about to stop A anyway, moments later, before ever creating B's container.
- **Decision:**
  1. `kvCacheReserveBytes` now computes `KV_bytes / kv_cache_free_gpu_memory_fraction` as
     `required_free`'s addition to the weights, where
     `KV_bytes = 2 × num_hidden_layers × num_key_value_heads × head_dim × kv_dtype_bytes ×
     context_length` (`kvCacheBytes`) — the real per-sequence KV-cache footprint at the given context
     length, `kv_dtype_bytes` `1` for an `FP8` `kv_cache_quant_algo` (`quant-format.ts`'s
     `kvCacheQuantAlgo`) else `2`. Dividing `KV_bytes` by the fraction, rather than adding it
     directly, matches what `trtllm-serve` actually guarantees: the engine spends only that fraction
     of *post-weight* free memory on the KV cache, so guaranteeing `KV_bytes` of real capacity needs
     `KV_bytes / fraction` of memory left over once weights are loaded. The older
     `weights × (1 − fraction)` rule survives as a documented fallback, used only when `config.json`
     lacks the fields the real formula needs, and `ModelCompatibility.kv_reserve_basis`
     (`'config' | 'weight_fraction'`) now says which rule produced a given verdict, so a fallback
     answer is never silently indistinguishable from a real one.
  2. The check itself splits into `checkModelCompatibilityFiles` (files, architecture, format,
     compute capability — everything that cannot change by evicting a previous session) and
     `checkModelMemory` (the memory line alone, re-reading the selected card's free memory from
     whatever `gpus[]` snapshot it is given, by `gpu_id`, never trusting a copy carried over from the
     first half). `checkModelCompatibility` (the `/check` route's single live snapshot, where there is
     no previous session on the card to evict) is just the two run back to back, unchanged from the
     caller's point of view. The load path no longer is: `runtime.ts` runs
     `verifyModelFilesAndCompatibility` (`prelaunch.ts`) *before* `lifecycle.load`, and passes a new
     `beforeCreate` hook — `ManagedLoadRequest.beforeCreate?: () => Promise<void>`, added to the
     engine-neutral managed-text lifecycle (`lifecycle.ts`) alongside the existing `stopPrevious` hook
     — that re-probes the host and calls `checkModelMemory` only once `stopPrevious` has resolved and
     right before the first `docker create` attempt. A same-card model switch on a single-GPU host now
     sees the card the previous session just freed, not a snapshot taken before eviction.
  3. `family` (tools/structured output/route policy) is now read off the *verified*
     `checkModelCompatibilityFiles` result's architecture — the one just confirmed against
     `config.json` on disk and the descriptor's `supported_architectures` — instead of `model.yml`'s
     own, separately-read copy, which could disagree with it (finding 5).
- **Consequences:** `checkModelCompatibility`/`checkModelCompatibilityFiles`/`checkModelMemory` now
  take a `MemorySizingInputs` (`{contextLength, kvCacheFreeGpuMemoryFraction}`) instead of a bare
  fraction; every caller (the `/check` route, the pre-launch check) already had a `context_length` in
  its resolved settings, so this is a same-shape substitution, not a new dependency. The `beforeCreate`
  hook is additive to `ManagedLoadRequest` and runs once, before the create/retry loop — task 2.15's
  own lifecycle changes (GPU residency, the `stopping-previous` path) touch an earlier stage of the
  same function and do not interact with it. The 75 GB FP8 / 80 GB card and the 79 GB shortage
  scenarios from the superseded record are replaced by two scenarios pinned to a real shape: a 70B-
  class checkpoint at the default context length still fits an 80 GB card, and an 8B checkpoint at a
  128k context is refused on a 24 GB card even though its weights alone would fit — the case the
  weight-proportional rule could never represent, since it has no notion of context length at all.
- **Owner:** team.
- **Links:** openspec change `add-tensorrt-llm-linux`, task 2.16 wiring, review round 1
  (`findings-2.16w-r1.md`, findings 1 (Critical), 5, 6); spec `tensorrt-llm-models`; spec
  `tensorrt-llm-runtime` (the `kv_cache_free_gpu_memory_fraction` and `context_length` settings);
  `src/runtime/tensorrt-llm/{compatibility,quant-format,prelaunch,runtime}.ts`,
  `src/runtime/managed-text/lifecycle.ts`.

<!--
Supersedes: 2026-09-29-tensorrt-llm-model-check-kv-reserve-uses-the-configured-fraction.md (the whole
record: the formula it documented is replaced, not merely refined) and the KV-reserve half of
2026-09-28-tensorrt-llm-model-check-kv-reserve-and-gpu-selection.md (already superseded once; the
unified-memory GPU-selection half of that original record is still unchanged and still in force).
-->
