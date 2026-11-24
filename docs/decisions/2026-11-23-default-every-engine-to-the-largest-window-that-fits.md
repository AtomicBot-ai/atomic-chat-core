---
date: 2026-11-23
title: "Default every engine to the largest window that fits"
---

# 2026-11-23 — Default every engine to the largest window that fits

- **Context:** Models started with small windows that had little to do with the device:
  - llama.cpp with fit on a discrete GPU kept every layer on the card and shrank the window to
    the `--fit-ctx` floor of 4096.
  - llama.cpp with fit off, and MLX, used a fixed 32K, or 16K on a small Mac. The app capped MLX
    at 16K itself.
  - TensorRT-LLM always ran 8192.
  - vLLM and SGLang tried at most 64K.

  Coding agents need tens of thousands of tokens. The owner asked for the largest window the
  model and the device allow, without anchoring on a fixed number. Overflowing chats are now
  compacted instead of grown (companion ADR), so a large default is the main lever.
- **Decision:** A per-device plan sets the default window. It is the largest window, starting
  from the trained one and stepping down by 256, that this device holds for this model:
  - **Unified memory:** weights + KV + 1 GiB within fit's half-of-RAM budget
    (`2026-09-29-leave-half-of-ram-…`). The <16 GiB 32K ceiling stays
    (`2026-10-29-cap-the-fitted-window-…`).
  - **Discrete GPU:** the card's free memory minus fit's margin. The window may push at most
    `GPU_OFFLOAD_WEIGHT_SHARE` (0.25) of the weights into system RAM, beyond what has to leave
    the card anyway, and no more than free RAM minus 2 GiB. A quarter of a dense model in RAM
    makes generation roughly 2× slower. In exchange, an 8B Q4 on an 8 GB card gets about 17K
    instead of about 5K.
  - **CPU:** half of RAM, and no more than free RAM minus 2 GiB.

  The plan never goes below what that load got before, so no default gets narrower. It is
  `recommendedCtx == maxCtx` today; the two fields let a future cap differ.

  How each engine uses the plan:
  - **llama.cpp, fit on, discrete GPU:** the plan becomes `--fit-ctx`. fit then keeps that
    window and moves layers itself (llama.cpp `common/fit.cpp`). This applies only while
    `fit_ctx` is unset or 4096, the schema default.
  - **llama.cpp, fit on, unified memory:** llama.cpp already fits the largest window; unchanged.
  - **llama.cpp, fit off, MLX, and Strata on GGUF:** the plan is the default window.
  - **llama.cpp growth:** `autoIncreaseCtx` grows straight to the plan's maximum in one reload.
  - **vLLM and SGLang:** the automatic window starts at the checkpoint maximum.
  - **TensorRT-LLM:** gains an automatic mode, `context_length: 0`, which is the new default. A
    migration moves a stored 8192 to 0.
  - **Capabilities:** `contextPlan` is part of `GET /models/:p/*m/capabilities`. FastFlowLM,
    GenieX, LiteRT-LM and Foundry Local report their model's own window there.
- **Consequences:**
  - In the fixtures: an 8B Q4 on a 12 GB RTX gets 50K with fit on (was 4096); on a 36 GB Mac,
    about 100K; Qwen3-30B-A3B on an 8 GB card, 51K.
  - Larger windows load more slowly and leave less RAM to other apps.
  - Off Apple silicon, every load now runs one more `--list-devices`.
  - On TensorRT-LLM, CUDA graphs still take their room first: an 8B model on a 4090 gets 32K,
    not 40K.
  - vLLM and SGLang keep two sequences above 32K.
  - Strata's own buffers are not modelled; check its larger windows on a real card.
  - The app must stop sending explicit 16K defaults and must not raise `fit_ctx` below the plan.
    An explicit `fit_ctx` turns the plan off.
- **Owner:** `team`.
- **Links:** `src/runtime/llamacpp/context-plan.ts`, `load-plan.ts`, `args.ts`,
  `src/runtime/mlx/runtime.ts`, `src/runtime/managed-models/auto-limits.ts`,
  `src/runtime/tensorrt-llm/`, `src/models/capabilities.ts`, `src/settings/default-migrations.ts`;
  `2026-11-23-compact-overflowing-chat-history-on-every-engine.md`.
