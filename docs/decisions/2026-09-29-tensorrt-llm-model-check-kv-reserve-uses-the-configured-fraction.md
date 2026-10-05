---
date: 2026-09-29
title: "tensorrt-llm model check: the KV-cache reserve is weight bytes times (1 - kv_cache_free_gpu_memory_fraction)"
---

# 2026-09-29 — tensorrt-llm model check: the KV-cache reserve is weight bytes times (1 - kv_cache_free_gpu_memory_fraction)

- **Context:** The 2026-09-28 record (`2026-09-28-tensorrt-llm-model-check-kv-reserve-and-gpu-selection.md`)
  fixed `checkModelCompatibility`'s KV-cache reserve at a flat, hardcoded `10%` of a checkpoint's
  weight bytes (`KV_CACHE_RESERVE_FRACTION_OF_WEIGHTS`), explicitly as a placeholder: task 2.14's
  provider setting `kv_cache_free_gpu_memory_fraction` (spec `tensorrt-llm-runtime`, "доля свободной
  GPU-памяти под KV-cache") did not exist yet. It now does (`src/runtime/tensorrt-llm/adapter.ts`,
  default `0.9`, bounds `[0.1, 0.95]`), and task 2.16's wiring (`ModelRegistry`, the check route, the
  pre-launch check) is the first caller that has a settings store to read it from. Carry item 4 asks
  for the placeholder to be replaced by a rule "derived from the provider's KV fraction setting" that
  still keeps the "75 GB FP8 on an 80 GB card" scenario meaningful (able to land on either `ok` or a
  real, numbered shortage), which rules out the naive fix of reusing `trtllm-serve`'s own formula
  verbatim: that formula reserves `kv_cache_free_gpu_memory_fraction` of memory still free *after*
  weights load, so `weights + kv_fraction * (free - weights) <= free` reduces algebraically to
  `weights <= free`, true whenever the checkpoint fits at all — the check would pass almost
  unconditionally regardless of the fraction, which is exactly the failure the 2026-09-28 record
  already ruled out.
- **Decision:** `kvCacheReserveBytes(weightBytesTotal, kvCacheFreeGpuMemoryFraction)` is now
  `weightBytesTotal * (1 - kvCacheFreeGpuMemoryFraction)`, rounded up.
  `checkModelCompatibility` takes `kvCacheFreeGpuMemoryFraction` as a required argument — this module
  stays settings-free, so the caller (the check route, the pre-launch re-check) reads the provider's
  stored `kv_cache_free_gpu_memory_fraction` (falling back to its adapter default, `0.9`, exactly the
  way a load already does) and passes it in. `1 - kv_cache_free_gpu_memory_fraction` is the share of
  *post-weight* memory the setting leaves unspent as headroom; scaling that share against the
  checkpoint's own weight bytes instead of against remaining free memory keeps the number real (no
  context length or running session needed) while still moving in the direction the setting implies:
  a caller who raises `kv_cache_free_gpu_memory_fraction` (spend more of what is left on the KV
  cache) shrinks this reserve, and one who lowers it (keep more headroom) grows it. At the setting's
  own default, `0.9`, the reserve is `10%` of weight bytes — numerically identical to the previous
  hardcoded placeholder, so the "75 GB FP8 on an 80 GB card" (`ok`) and "79 GB FP8 on the same card"
  (a real, numbered shortage) scenarios in `compatibility.test.ts` are unchanged at the default
  setting, and a new test pins the same 75 GB checkpoint turning into a shortage at a lower configured
  fraction (`0.5`), so the setting visibly changes the verdict rather than being wired in unused.
- **Consequences:** The reserve is still not a measurement of `trtllm-serve`'s real engine-build-plus-
  KV footprint (live testing, tasks 2.18/2.19, is still the source of truth for that); what changed is
  only that the number now moves with a setting the operator actually controls instead of being fixed.
  Every caller of `checkModelCompatibility`/`kvCacheReserveBytes` must now pass the fraction — the
  check route and the pre-launch re-check (`check.ts`, `prelaunch.ts`, task 2.16) both read it from
  `tensorrtLlmSettings()`, the same helper `runtime.ts`'s load path already uses, so a load and the
  check that preceded it never disagree about which fraction was in force. `fits_other_gpus` and the
  memory verdict both still key off this one function, so a future change here changes both, same as
  before.
- **Owner:** team.
- **Links:** openspec change `add-tensorrt-llm-linux`, task 2.16 (wiring part), carry item 4; spec
  `tensorrt-llm-models` (scenario "Большая модель на datacenter-карте"); spec `tensorrt-llm-runtime`
  (the `kv_cache_free_gpu_memory_fraction` setting); `src/runtime/tensorrt-llm/{compatibility,adapter}.ts`.

<!--
Supersedes: 2026-09-28-tensorrt-llm-model-check-kv-reserve-and-gpu-selection.md (only its KV-reserve
half; the unified-memory GPU-selection half of that record is unchanged).
-->
