---
date: 2026-09-29
title: "Leave half of RAM to the system when fitting on unified memory"
---

# 2026-09-29 — Leave half of RAM to the system when fitting on unified memory

- **Context:** Fit is on by default since app v2.0.36 (ATO-465), and under fit the core emits no
  `--ctx-size`. llama.cpp then starts from the model's trained context and shrinks it only until
  weights, KV cache and compute buffers fit the device's free memory minus `--fit-target` (1024 MiB).
  On Apple silicon the device is Metal, whose free memory is `recommendedMaxWorkingSetSize` minus what
  the process itself holds — about three quarters of RAM on current macOS (18186 MiB of 24 GiB on an
  M4 Pro, macOS 26), per process, blind to every other app. A dense-attention model with a long
  trained context takes all of it: Nanbeige4.2-3B IQ4_XS (2.2 GB of weights, 256K trained context,
  176 KiB of fp16 KV per token because its 22 layers run twice) made llama-server a 10 GB process on
  an 18 GB Mac, which swapped until it was unusable. Measured with llama.cpp b10809 on the 24 GiB M4
  Pro: fit chose 84992 tokens, a 14608 MiB KV buffer and a 14 GB footprint. Before v2.0.36 every load
  was a fixed 16384. llama.cpp offers no ceiling for the fitted context: an explicit `--ctx-size`
  switches the context fitting off altogether, and `--fit-ctx` is a floor.
- **Decision:** On Apple silicon, when fit is on, the margin is still llama.cpp's default (empty or
  `1024`) and no other device is pinned, the load plan widens `--fit-target` so llama.cpp is left with
  half of RAM: `margin = metalFree − max(RAM / 2, weights + KV at the fit floor × slots + 1 GiB)`,
  emitted only when it beats 1024 MiB. `metalFree` is the `MTL*` device's free memory from
  `<exe> --list-devices` of the very build about to load (≈ 80 ms), so it follows Apple's rule on the
  running macOS and any `iogpu.wired_limit_mb` without the core knowing either; RAM comes from
  `probeUnifiedMemory` in `src/hardware/` (`os.totalmem`, Apple silicon only). The weights floor keeps
  a model that needs more than half of RAM exactly where it was: past that point a wider margin would
  not shrink the context, it would move layers to the CPU. llama.cpp still picks the window inside the
  budget with its own per-layer accounting, so sliding-window and hybrid models keep long contexts.
  CUDA, Vulkan and Intel Macs are unchanged: a discrete GPU's memory is llama.cpp's to fill.
- **Consequences:** Same machine and build as above, through the compiled core: `--fit-target 5897`,
  57344 tokens, a 10 GB footprint instead of 14 GB. On an 18 GiB Mac the budget is 9 GiB instead of
  ~12.3 GiB — still most of RAM for a small model with a huge trained context, by choice: the window
  stays as large as half of RAM allows. A margin the user typed stands, and `1024` typed by hand reads
  as the default (the args builder already treats it so). A load on Apple silicon under fit spawns one
  extra `--list-devices`; if it fails or lists no Metal device, the default margin stands. The KV
  estimate behind the floor counts `block_count` layers once — it undercounts looped models such as
  Nanbeige and overcounts hybrid ones; the 1 GiB reserve absorbs the former at the fit floor. Metal's
  free memory is per process, so two loaded models can each take half of RAM. Pinned by
  `fit-margin.test.ts`, the load-plan cases, `probe-darwin.test.ts` and `test/e2e/fit-margin.test.ts`.
- **Owner:** `team`
- **Links:** `src/runtime/llamacpp/fit-margin.ts`, `src/runtime/llamacpp/load-plan.ts` (step 19b),
  `src/hardware/probe-darwin.ts` (`probeUnifiedMemory`), llama.cpp `common/fit.cpp`
  (`common_params_fit_impl`), `ggml/src/ggml-metal/ggml-metal-device.m`
  (`ggml_metal_device_get_memory`).
