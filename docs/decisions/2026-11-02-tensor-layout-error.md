---
date: 2026-11-02
title: "Classify tensor-layout mismatches without claiming corruption"
---

# 2026-11-02 — Classify tensor-layout mismatches without claiming corruption

- **Context:** An Ollama model matched its full SHA-256 digest, yet llama.cpp b11946 rejected it with "wrong number of tensors; expected 1189, got 833". Upstream llama.cpp reported that as `MODEL_FILE_CORRUPT`, so the user was told to re-download a file that was intact. Atomic Server has shipped this correction as a patch of the 0.20.7 package since AtomicBot-ai/atomic-server#69.
- **Decision:** A tensor-count mismatch is `MODEL_ARCH_NOT_SUPPORTED` on upstream llama.cpp as well as on the TurboQuant fork. Explicit truncation, invalid magic and end-of-file markers stay `MODEL_FILE_CORRUPT`.
- **Consequences:** The desktop fixtures stay as recorded; `test/contract/errors.test.ts` names the intentional difference. Once a core release carries this, Atomic Server drops its package patch.
- **Owner:** team.
- **Links:** `src/runtime/llamacpp/errors.ts`, AtomicBot-ai/atomic-server#69 (`patches/core-model-error-source.diff`).
