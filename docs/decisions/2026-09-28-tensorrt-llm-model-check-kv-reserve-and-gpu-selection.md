---
date: 2026-09-28
title: "tensorrt-llm model check: a fixed KV-cache reserve fraction, and unified memory ranks as zero for GPU selection"
---

# 2026-09-28 — tensorrt-llm model check: a fixed KV-cache reserve fraction, and unified memory ranks as zero for GPU selection

- **Context:** Task 2.16 (`src/runtime/tensorrt-llm/compatibility.ts`) implements the pure
  `POST /atomic/v1/models/tensorrt-llm/check` verdict (spec `tensorrt-llm-models`): weight bytes plus
  a KV-cache reserve must fit the selected GPU's free memory. Two inputs this check needs are not yet
  decided by anything: a checkpoint's context length (a provider setting, task 2.14) and
  `kv_cache_free_gpu_memory_fraction` (also a provider setting, task 2.14, spec `tensorrt-llm-runtime`
  §"доля свободной GPU-памяти под KV-cache"). `trtllm-serve`'s real behavior is to reserve that
  fraction of whatever memory remains free *after* weights load, for a KV cache sized by context
  length — neither of which this check has. Reusing the real fraction against *remaining* free memory
  anyway would make the check nearly always pass (weights + `0.9 * (free - weights)` is always less
  than `free` whenever weights fit at all), which defeats the point of the check for exactly the case
  the spec calls out by name: "75 GB FP8 on an 80 GB card" should be able to come back as either `ok`
  or a real shortage with numbers, not always `ok` by construction. Separately, `selectLaunchGpu`
  (also exported here, for task 2.14's load path to reuse) has to rank GPUs by "most memory" when no
  `gpu_id` is given, and a unified-memory card (design D13, GB10/DGX Spark) reports
  `total_vram_bytes: null` — there is no nominal card-memory figure to compare it against another
  card's `total_vram_bytes` with.
- **Decision:** `kvCacheReserveBytes` reserves `KV_CACHE_RESERVE_FRACTION_OF_WEIGHTS = 0.1` (10%) of
  the checkpoint's own weight bytes, not a fraction of remaining free memory. This is a documented
  placeholder, not a measurement: it exists so the check can report real numbers today without a
  context length or the real provider setting, and is expected to be replaced (or at least
  re-derived) once task 2.14 threads an actual context length and
  `kv_cache_free_gpu_memory_fraction` through a pre-launch re-check. `selectLaunchGpu` ranks by
  `total_vram_bytes ?? 0`, so a unified-memory card sorts alongside a hypothetical 0-byte card rather
  than being treated as infinite: the function has no host-memory figure available to it (only
  `MemAvailable` — the per-check inputs, not a value bundled into `GpuFacts`) and would otherwise be
  guessing. The only descriptor case this affects today is single-GPU (GB10/DGX Spark has exactly one
  GPU), where the card is still selected as the sole candidate regardless of how it ranks.
- **Consequences:** Both numbers are call-out risks for task 2.14 and for the live tests in tasks
  2.18/2.19: the 10% reserve has not been measured against a real `trtllm-serve` engine-build-plus-KV
  footprint, and a host with more than one GPU where one is unified-memory is not a case the "most
  memory" rule was tuned for (no such host exists in the curated hardware list; DGX Spark ships as a
  single GPU). If live testing on the pinned engine tag shows the 10% reserve is too small (engine
  build overhead larger than expected) or unnecessarily conservative, change
  `KV_CACHE_RESERVE_FRACTION_OF_WEIGHTS` and its doc comment together, and prefer wiring in the real
  `kv_cache_free_gpu_memory_fraction` once a context length is available rather than tuning the
  placeholder further. `fits_other_gpus` and the memory verdict both key off this constant, so a
  change here changes both.
- **Owner:** team.
- **Links:** openspec change `add-tensorrt-llm-linux` (`atomic-chat-spec`), task 2.16, design
  D12/D13; spec `tensorrt-llm-models` (scenario "Большая модель на datacenter-карте"); spec
  `tensorrt-llm-runtime` (KV-cache fraction provider setting); `src/runtime/tensorrt-llm/compatibility.ts`.
