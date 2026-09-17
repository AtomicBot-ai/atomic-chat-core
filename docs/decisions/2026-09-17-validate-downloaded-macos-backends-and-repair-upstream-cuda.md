---
date: 2026-09-17
title: "Validate downloaded macOS backends and repair installed upstream CUDA packs"
---

# 2026-09-17 — Validate downloaded macOS backends and repair installed upstream CUDA packs

- **Context:** Stage 6 removed the extensions' pre-load Windows CUDA repair and macOS post-download launch check. An executable file alone neither proves a macOS archive has the requested build nor supplies CUDA DLLs to an older Windows pack.
- **Decision:** Restore executable bits on all downloaded macOS `build/bin` files, then run upstream `llama-server --version` from staging and compare its build before replacing the installed pack. Before every Windows upstream CUDA load, check for the runtime DLL, migrate the legacy app library when present, otherwise fetch and merge the matching companion archive. Continue treating repair failure as a warning because a system CUDA toolkit may still satisfy the binary.
- **Consequences:** Failed macOS downloads leave the working pack untouched. Existing Windows packs can recover without reinstalling. Launch verification executes a downloaded binary; it is restricted to the same macOS upstream path that previously did so and bounded by a timeout.
- **Owner:** team.
- **Links:** `src/backend/install/service.ts`, `src/backend/turboquant.ts`, `src/core/create.ts`.
