---
date: 2026-09-21
title: "Classify llama.cpp failures per provider"
---

# 2026-09-21 — Classify llama.cpp failures per provider

- **Context:** `src/runtime/llamacpp/errors.ts` ported one error cascade, the upstream plugin's, for both llama.cpp providers, because the two plugins' `error.rs` agreed. App v2.0.42 changed the TurboQuant fork's copy only: `wrong number of tensors` now means `MODEL_ARCH_NOT_SUPPORTED` there (the fork knows the architecture but expects a different tensor layout; the same GGUF loads in stock llama.cpp, so re-downloading cannot help), while upstream still calls it `MODEL_FILE_CORRUPT`. The contract fixtures in `test/fixtures/app/errors/` come from the upstream plugin.
- **Decision:** The classifiers take the provider (default `llamacpp-upstream`, which keeps every fixture and caller as it was), and `LlamacppRuntime` passes its plan's provider both at load and when a session dies.
- **Consequences:** The same process output can now yield two different codes depending on who ran it; a test holds both. A future divergence between the two plugins' cascades goes in the same place.
- **Owner:** team.
- **Links:** `src/runtime/llamacpp/{errors,runtime}.ts`; app `src-tauri/plugins/tauri-plugin-llamacpp/src/error.rs` at `ec1fd3ea7` (commit `15c3c52a9`).
