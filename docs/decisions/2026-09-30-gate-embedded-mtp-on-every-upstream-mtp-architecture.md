---
date: 2026-09-30
title: "Gate embedded MTP on every upstream MTP architecture"
---

# 2026-09-30 — Gate embedded MTP on every upstream MTP architecture

- **Context:** `hasEmbeddedMtp` accepted only `qwen35` and `qwen35moe`, so the load plan dropped the MTP flag
  (`load-plan.ts`, step 13) for every other GGUF, even one that carries an MTP head llama.cpp can run. Upstream
  b10809 (commit 5266f24da, the backend the app recommends) builds `LLM_GRAPH_TYPE_DECODER_MTP` for 14
  architectures: `bailingmoe3`, `cohere2moe`, `deepseek2`, `deepseek32`, `deepseek4`, `glm-dsa`, `glm4moe`,
  `hy_v3`, `mimo2`, `nemotron_h_moe`, `qwen35`, `qwen35moe`, `qwen3next`, `step35`. Owner feedback: the MTP
  refusal looked far narrower than what upstream supports.
- **Decision:** `EMBEDDED_MTP_ARCHITECTURES` lists those 14 names. The metadata rule is unchanged: the GGUF must
  report `{arch}.nextn_predict_layers` > 0 and below `{arch}.block_count`.
- **Consequences:** With MTP on, GLM-4.5/4.6/4.7, Qwen3-Next, DeepSeek V3/V3.2/V4 and the others load with
  `--spec-type draft-mtp` when their GGUF kept the head. An older backend that lacks the graph for one of them
  fails the MTP context, and the existing `without-mtp` retry loads it without MTP. The list tracks upstream by
  hand: re-check `src/models/*.cpp` for `LLM_GRAPH_TYPE_DECODER_MTP` when the recommended backend moves. The
  app's copy (`extensions/llamacpp-upstream-extension/src/util.ts`) decides whether the settings toggle is
  accepted and must list the same names.
- **Owner:** team
- **Links:** `src/models/gguf/classify.ts`, `src/runtime/llamacpp/load-plan.ts`,
  https://github.com/ggml-org/llama.cpp/tree/5266f24da/src/models
