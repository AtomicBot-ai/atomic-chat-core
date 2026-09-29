---
date: 2026-09-29
title: "tensorrt-llm: the default KV-cache fraction is 0.8, and an early exit is classified from the whole log"
---

# 2026-09-29 — tensorrt-llm: the default KV-cache fraction is 0.8, and an early exit is classified from the whole log

- **Context:** The first live run on a VM found two defects. The setup was Ubuntu 24.04, an RTX 4070 Laptop
  (8 GB) passed through (the guest sees 7.70 GiB), driver 615.71.09, TRT-LLM 1.2.1 and Qwen/Qwen3-1.7B bf16
  with `--max_seq_len 4096 --max_num_tokens 4096` and xgrammar guided decoding on.
  1. The core launched `trtllm-serve` with `--kv_cache_free_gpu_memory_fraction 0.9`. That is
     `trtllm-serve`'s own default, and the adapter's `TENSORRT_LLM_DEFAULT_KV_CACHE_FREE_FRACTION`
     copied it (records `2026-09-29-tensorrt-llm-model-check-kv-reserve-uses-the-configured-fraction.md`
     and `2026-09-29-tensorrt-llm-kv-reserve-is-the-real-formula-and-memory-is-checked-after-eviction.md`
     treat 0.9 as the default). The load failed with "CUDA out of memory" in 2 runs out of 2, and the
     core's own memory check had said the model fits. The engine's budget table read
     `_no_capture_init_kv_cache: 3.50 / 0.35` and `_no_capture_init_extra_resources: 0.34 / 0.10`. The
     KV cache took 90% of what was free after the weights, and the engine's other allocations did not
     fit in what was left. The check is not wrong about the model: it sizes the KV cache the context
     needs (`weights + KV_bytes / fraction`, about 4.65 GB here with the ~4.06 GB checkpoint, on a 7.70 GiB card). It cannot see that the
     engine then takes a *fraction of all remaining memory* for the cache, whatever the context needs.
     Direct runs of the same image and arguments, with only the fraction changed:

     | fraction | host | result |
     | --- | --- | --- |
     | 0.9 | VM, driver 615 | OOM (2/2 through the core, and direct) |
     | 0.85 | VM, driver 615 | OOM: "Tried to allocate 48.00 MiB ... 42.69 MiB is free" |
     | 0.8 | VM, driver 615 | ready, 7103 MiB used, chat answers |
     | 0.9 | bare metal, driver 595, same card | ready, peak 7.9 of 8.6 GB (no headroom) |

  2. Run 1 surfaced `OUT_OF_MEMORY`. Run 2 had the same failure but surfaced `MODEL_LOAD_FAILED`
     "trtllm-serve exited unexpectedly with exit code 1 before it became ready". Its last log line was
     `RuntimeError: Executor worker returned error`, and the out-of-memory lines ("CUDA out of memory",
     "The GPU ran out of memory", `torch.AcceleratorError: CUDA error: out of memory`) were higher up.
     The lifecycle handed the adapter only the last 200 lines (`logTailLines`, record
     `2026-09-28-managed-text-lifecycle-owns-load-stages-cache-and-stop.md`: "classified by the
     adapter from the log tail"). The adapter's patterns did not know the `AcceleratorError` wording
     either, so which code a user saw depended on how the worker's traceback happened to interleave.
- **Decision:**
  1. `TENSORRT_LLM_DEFAULT_KV_CACHE_FREE_FRACTION` is **0.8**, and `src/settings/schema/tensorrt-llm.json`
     stores the same value (`settings.test.ts` checks that the two are equal). 0.8 is the highest
     tested value that loaded on the VM, where 0.85 still failed. It stays one number: the launch argv, the `/check` route and the pre-launch memory
     check all read it through the same validated settings (`tensorrtLlmSettings` →
     `kv_cache_free_gpu_memory_fraction`), so the check and the launch cannot drift apart. The reserve
     formula is unchanged: `KV_bytes / fraction` from `config.json`, and the `weights × (1 − fraction)`
     fallback only when `config.json` lacks the shape. At 0.8 the fallback reserves 20% of the weights
     instead of 10%, so a checkpoint without a KV shape is judged more strictly. The user setting keeps
     its bounds `[0.1, 0.95]`.
  2. When a container exits before it is ready, the adapter classifies it from the container's **whole
     log** (`docker logs --tail all`, still bounded by the docker exec's 4 MiB per-stream cap), not
     from the tail. `classifyTensorrtLlmExit` searches every line and now also matches
     `CUDA error: out of memory`, `_maybe_explain_if_oom`'s "Executor creation failed due to
     insufficient GPU memory." and "The GPU ran out of memory" (as the run reported it; no source line
     is pinned for it). It returns the matching lines, deduplicated and capped at 8 lines of 500
     characters, as the new optional `ManagedExitClassification.excerpt`. The error's `details` (and
     the last attempt's `log_tail`) stay the 200-line tail. When the tail no longer contains the
     excerpt, the excerpt goes first, followed by `[…] the end of the log:` (`exitFailureDetails`).
     A crash *after* readiness is still classified from the tail. A long-running server's whole log
     can hold an old, handled OOM that has nothing to do with the crash.
- **Consequences:**
  - About 11% less KV cache (0.8 / 0.9) at the same free memory, so about 11% fewer cacheable tokens
    for batching and prefix reuse. `--max_seq_len` still bounds a single request, so the context
    window itself does not shrink. On large cards this headroom is more than needed.
  - A `settings.json` written before this change keeps its stored 0.9, because the store persists
    defaults. The feature is unreleased, so only test machines are affected. Reset the key, or use a
    fresh data folder, before the next live run. The app mirrors `tensorrt-llm.json` with a checksum
    (task 3.2) and has to pick up the new default.
  - Every load that fails before readiness now makes one extra `docker logs` call. The added cost is
    one process and up to 4 MiB of memory, only on the failure path.
  - `ManagedExitClassification.excerpt` is optional and additive, so the adapter contract version stays
    1.
  - **Follow-up, not done here:** size the KV cache for the configured context instead of as a fraction
    of free memory. The idea is to write `kv_cache_config: {max_tokens: <context_length × max batch>}`
    into the per-generation `llm-api-options.yaml` that guided decoding already uses. The engine would
    then take only what the check reserved, the check and the engine would use the same number, and
    the leftover headroom would not depend on how much memory a card has. It needs a decision on batch
    size and a live run to confirm that `max_tokens` wins over the fraction in 1.2.1.
- **Owner:** team
- **Links:** `src/runtime/tensorrt-llm/adapter.ts` (`TENSORRT_LLM_DEFAULT_KV_CACHE_FREE_FRACTION`,
  `classifyTensorrtLlmExit`), `src/settings/schema/tensorrt-llm.json`,
  `src/runtime/managed-text/lifecycle.ts` (`exitFailure`), `src/runtime/managed-text/load-policy.ts`
  (`exitFailureDetails`), `src/runtime/container/{argv,operations}.ts` (`--tail all`).

<!--
Amends: 2026-09-29-tensorrt-llm-kv-reserve-is-the-real-formula-and-memory-is-checked-after-eviction.md (the default fraction it assumes)
Amends: 2026-09-29-tensorrt-llm-model-check-kv-reserve-uses-the-configured-fraction.md (its "default 0.9")
Amends: 2026-09-28-managed-text-lifecycle-owns-load-stages-cache-and-stop.md (early exit classified from the tail)
-->
