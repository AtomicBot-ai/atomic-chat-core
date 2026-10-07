---
date: 2026-10-06
title: "One model store for every managed engine; TensorRT-LLM's models move into it at startup"
---

# 2026-10-06 — One model store for every managed engine; TensorRT-LLM's models move into it at startup

- **Context:** TensorRT-LLM kept its models in `<data>/tensorrt-llm/models` (in the WSL guest, `…/models/tensorrt-llm`), with `GET /models/tensorrt-llm/location` and `DELETE /models/tensorrt-llm/:id`. vLLM reads the same Hugging Face checkpoints. A folder per engine would double gigabytes and hide a model downloaded "for TensorRT-LLM" from vLLM.
- **Decision:** one root, `<data>/managed-models` (`managed-models/` in the scope's guest folder on Windows); every managed provider lists all of it under the same ids, and whether a model runs on an engine is decided when it loads. `GET /managed-models/location` and `DELETE /managed-models/:id` replace the TensorRT-LLM routes (no aliases: the app pins core and moves in the same change; the CLI has no managed engines). `model.yml` carries nothing engine-dependent; an old `quantization` field is ignored. Core moves TensorRT-LLM's models in at startup — on Linux before the environment and the engines are wired, under the core's own lock on its data folder; on Windows in the guest, once per process, before the first look at the store, with the distribution held — by renaming each folder with `model.yml`. Half downloads stay; an id already in the store leaves both folders alone and is reported in `EnvironmentDiagnostics.store_migration`. Removing an engine with `retain_models: false` deletes the store only when no other managed engine is installed.
- **Consequences:** one copy on disk for every engine; engine caches stay valid (their key is the descriptor and the model id). Rolling the app back to a core before this one hides the moved models (it looks in the old root) — nothing is deleted, and a manual `mv` brings them back. A partial TensorRT-LLM download started before the update is not continued in the new root.
- **Owner:** `team`.
- **Links:** `src/runtime/managed-models/{model-dir,registry,location,delete,migrate}.ts`, `src/runtime/environment/store-models.ts`, `src/core/{create,managed-engines}.ts`; openspec change `add-vllm-runtime`, design D4, D5, D13; spec `managed-model-store`.
