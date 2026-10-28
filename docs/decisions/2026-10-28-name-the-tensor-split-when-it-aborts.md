---
date: 2026-10-28
title: "Name the tensor split when llama.cpp's meta backend aborts"
---

# 2026-10-28 — Name the tensor split when llama.cpp's meta backend aborts

- **Context:** llama.cpp builds a "meta" device only for `--split-mode tensor`
  (`src/llama.cpp`; `docs/multi-gpu.md` calls the mode experimental). When that split
  cannot handle a graph, it stops with `GGML_ABORT` in `ggml-backend-meta.cpp`, e.g.
  `unsupported mul_mat split states` for an embedding model on two CUDA GPUs (ATO-556).
  The cascade had no rule for it, so the user read "The model process encountered an
  unexpected error." followed by the raw log. On Unix the abort exits on SIGABRT, which
  would have turned even a specific message into the generic crash text. The settings
  offer no tensor split, so it can only come from custom arguments.
- **Decision:** A new last rule in `classifyStderr`: any stream that mentions
  `ggml-backend-meta.cpp` is `LLAMA_CPP_PROCESS_ERROR` with
  `TENSOR_SPLIT_FAILED_MESSAGE`, which says to remove `-sm tensor` from Additional
  llama-server Arguments or use the Layer split. `classifyExit` now upgrades only the
  generic message on a crash exit (the code check let any process-error message be
  replaced), so the specific message survives SIGABRT and Windows crash codes.
- **Consequences:** The code stays `LLAMA_CPP_PROCESS_ERROR`, so the app needs no
  change and the 41 app error fixtures are untouched. An out-of-memory under a tensor
  split still reads as out of memory (earlier rule). The argument-rejected message
  also survives a crash exit now, which it did not before. The engine contract
  gains `error.tensor-split.meta-abort` (unobservable on the one-GPU live probe) and
  watches `ggml/src/ggml-backend-meta.cpp` for upstream changes.
- **Owner:** `team`.
- **Links:** Linear ATO-556; `src/runtime/llamacpp/errors.ts`; ADR
  2026-10-28-embedding-loads-never-take-a-tensor-split (removes the cause for the
  embedding model).
