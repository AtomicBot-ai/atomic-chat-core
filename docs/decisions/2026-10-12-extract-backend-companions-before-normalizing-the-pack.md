---
date: 2026-10-12
title: "Extract backend companions before normalizing the pack"
---

# 2026-10-12 — Extract backend companions before normalizing the pack

- **Context:** PrismML's Windows CUDA ZIPs have `llama-server.exe` at the archive root. The installer
  downloaded the backend and its CUDA runtime companion into the same staging directory, then
  normalized the backend before extracting the companion. Normalization moved the unopened
  companion ZIP into `build/bin`, so the next extraction failed with `ENOENT` at its original path.
- **Decision:** Extract and remove manifest-declared companions before normalizing the backend
  layout. Companions still merge into `build/bin`; normalization keeps that directory in place.
- **Consequences:** Flat, nested and existing `build/bin` Windows CUDA packs install with their
  runtime DLLs. Download validation, launch checks and atomic publication keep their existing
  behavior. Tests cover both CUDA 12.4 and 13.3 and the compiled-binary setup with a flat POSIX
  fixture plus a companion; they do not claim a native Windows CUDA launch.
- **Owner:** @xDenside.
- **Links:** `src/backend/install/service.ts`, `src/backend/install/service.test.ts`,
  `test/e2e/model-setup.test.ts`;
  [PrismML release](https://github.com/PrismML-Eng/llama.cpp/releases/tag/prism-b10754-2459f68).
