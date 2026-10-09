---
date: 2026-10-09
title: "A build that dies while loading is skipped, and the user's own llama.cpp build goes first"
---

# 2026-10-09 — A build that dies while loading is skipped, and the user's own llama.cpp build goes first

- **Context:** The embedding and the upstream decision models pick their `llamacpp-upstream` build
  themselves (`orderUpstreamCandidates`): newest release first, then CUDA → ROCm/HIP → Vulkan → CPU,
  regardless of the build the user runs chat on. On a Windows machine with a Radeon card and both
  `b11463/win-hip…` and `b11463/win-vulkan-x64` installed (Vulkan recommended and selected), EmbeddingGemma 2
  started on the ROCm build. The model loaded, then the first product on the GPU failed in rocBLAS
  (`hipErrorInvalidKernelFile`: no kernels for the card's gfx target) and the process exited with code 9.
  The start fallback skipped only builds that readiness refused as unsupported; a process that died while
  loading (`MODEL_LOAD_FAILED`) ended the start, so the module stayed `failed` and the Vulkan build was
  never tried.
- **Decision:**
  - `spawnOnFirstGoodEngine` (`src/decision/engine-fallback.ts`), shared by both modules: a build that
    dies while loading or cannot be spawned (`MODEL_LOAD_FAILED`) is handed back to the gate like one
    readiness refused, and the next build is tried (at most `MAX_ENGINE_ATTEMPTS`). When a build crashed
    and none is left, the start fails with that crash — its message, the gate's list of every build it
    tried, and the crash's own output — not with "no build can run the model". A timeout still ends the
    start, and an explicit `engine_path` still has nothing to fall back to.
  - `orderUpstreamCandidates` takes the `llamacpp-upstream` `version_backend` the user picked: that build
    goes first when it is new enough; otherwise, inside a release, a pack of the same backend goes first;
    then the old release and GPU order. `create.ts` hands it to both modules (`upstreamBackend`).
- **Consequences:** On the reported machine the embedding model starts on Vulkan, the build chat already
  runs on, without ROCm being tried; with nothing picked, a crashing ROCm build costs one failed load and
  the next build runs. A model that crashes on every build (a broken file, too little memory) now loads
  once per build, at most eight times, before the start fails. Supersedes the "which build runs chat has
  nothing to do with which can run the embedding model" ordering note in
  `2026-10-07-embedding-models-are-their-own-core-module.md`.
- **Owner:** team
- **Links:** `src/decision/engine-fallback.ts`, `src/decision/engine-candidates.ts`, `src/decision/service.ts`,
  `src/embedding/service.ts`, `src/embedding/engine.ts`, `src/core/create.ts`.
