---
date: 2026-10-29
title: "Cap the fitted window on unified-memory Macs below 16 GiB"
---

# 2026-10-29 — Cap the fitted window on unified-memory Macs below 16 GiB

- **Context:** QA 2.2.29 B05: an 8 GiB M3 (macOS 26) with fit on and LFM2.5-2.6B Q4_K_M, the
  catalog's `unified_8` pick (1674455040 bytes, 131072 trained tokens, 8 of its 30 blocks attend:
  16 KiB of fp16 KV per token). Metal lists 5461 MiB free, ADR 2026-09-29 widens the margin to
  1365 MiB, so llama.cpp may fill 4096 MiB, and b11946's fit (`common/fit.cpp`) keeps the trained
  context whenever weights + KV + compute fit that: 1597 MiB + 2048 MiB + compute did, so 131072.
  Activity Monitor: llama-server 2.12 GB (its KV cache; mmap'd weights are file-backed), 5.78 GB
  wired, 4.15 GB swap, 23–30 s per UI action; a 4K window without fit was responsive. Half of RAM
  leaves the other 4 GiB to macOS, the app's WebView, the core and the embedding and decision
  servers — each its own process, so invisible to fit, whose Metal free memory is per process — and
  Metal's buffers are wired, so all of that pages instead. The margin cannot narrow the window: it
  only stops llama.cpp from filling more than half of RAM, and 4 GiB is what it filled. llama.cpp
  offers no ceiling; an explicit `-c` ends fit's context search while fit still places layers under
  the margin. The core's KV estimate could not size such a ceiling either: the reader left out a
  per-layer `head_count_kv` of more than 24 entries and the estimate then counted all 30 LFM2 blocks
  with 32 heads, 240 KiB a token.
- **Decision:** On Apple silicon with less than 16 GiB of RAM — fit on, the default margin, no other
  device pinned, not an embedding — the load plan caps the window at 32768 tokens, narrowed in
  steps of 256 until the weights, the KV estimate across the slots and the 1 GiB reserve fit the
  budget the margin leaves (Metal free − margin). 32768 rather than the app's 16384 default: the
  agents' prompts run to about 20K tokens (Atomic Agent, QA 2.2.29 B09) and must fit, 32768 is a
  step of the app's context ladder, and it is only a ceiling — the budget still narrows a dense model
  well below it, so only a model with a small KV cache reaches it. It goes out as `--ctx-size`
  (tokens × slots) beside `--fit on` and the margin (`smallUnifiedMemoryCtxCeiling`,
  `LoadPlan.fitCtxCeiling`). No ceiling when the KV cannot be estimated, the trained context is
  unknown or already fits, the fit floor (the user's or 4096) does not fit — fit then shrinks and
  offloads as before — or the user set a margin of their own. For the estimate to see hybrids, the
  reader inlines an integer `<arch>.attention.head_count_kv` at any length (up to 4096 entries; every
  other array keeps the Rust reader's placeholder past 24), and the estimate counts only the layers
  with KV heads, each with its own count, as llama.cpp allocates them. A scalar, the placeholder or
  an array with no KV head reads exactly as before.
- **Consequences:** LFM2.5-2.6B on that Mac gets `--ctx-size 32768`: 512 MiB of KV instead of
  2048 MiB, about 1.5 GiB less wired memory, with room for an agent's ~20K prompt. A dense model
  lands near its estimate (Llama-3.2-3B: 10240, where fit took about 13K), so an agent prompt does
  not fit it on an 8 GiB Mac. 16 GiB and up keep their window. The estimate behind the ADR
  2026-09-29 margin floor changes too, for models with a per-layer `head_count_kv` only: the
  floor gets smaller and true (LFM2.5-2.6B: 2685 MiB instead of 3581), which moves the margin only
  where the floor exceeded half of RAM, and never below what the weights and the fit floor need. A
  hybrid's recurrent state is not counted; it is a fixed few MiB per sequence (LFM2: under 1 MiB)
  inside the 1 GiB reserve. Sliding windows stay averaged and hybrids that mark attention layers
  some other way (`full_attention_interval`) stay counted in full, so both are narrowed more than
  needed — the safe side. A prompt wider than the window meets the app's existing fit path
  (`reason: 'fit'`, "turn off Fit to set the context by hand"); `autoIncreaseCtx` still declines
  under fit. A model the estimate undercounts (looped layers, ADR 2026-09-29) may get a layer or two
  moved to the CPU instead of a narrower window. The sidecars are still not counted in the budget.
  The app's own "will it fit" estimate (Rust) is untouched. Not yet checked on a real 8 GiB Mac.
  Pinned by `fit-margin.test.ts`, `kv-cache.test.ts`, `reader.test.ts`, and the load-plan, args
  and runtime cases.
- **Owner:** `team`
- **Links:** `src/runtime/llamacpp/fit-margin.ts`, `src/runtime/llamacpp/load-plan.ts` (step 19b),
  `src/runtime/llamacpp/args.ts`, `src/models/gguf/reader.ts`, `src/models/gguf/kv-cache.ts`,
  ADR 2026-09-29 (qualified, not superseded), llama.cpp b11946 `common/fit.cpp`
  (`common_params_fit_impl`), `common/arg.cpp` (`--fit-target`, `--fit-ctx`),
  `ggml/src/ggml-metal/ggml-metal-device.m` (`ggml_metal_device_get_memory`).
