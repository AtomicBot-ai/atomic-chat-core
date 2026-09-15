---
date: 2026-09-15
title: "backend/ keeps one Rust-derived category function and explicit recheck outcomes"
---

# 2026-09-15 — backend/ keeps one Rust-derived category function and explicit recheck outcomes

- **Context:** The app computed a backend's category (`cuda-cu13`, `vulkan`, `cpu`, …) in two
  places: Rust `get_backend_category` in `backend.rs` and a TypeScript copy in the extension's
  `index.ts`. The copies drifted: Rust returns `rocm`, `arm64` and `x64` for those ids, the TS copy
  returned `unknown`. The extension's optimal-backend recheck (`recheckOptimalBackend`,
  `detectIdealBackendType`) reported failure by returning `null` in some branches and by throwing
  a sentinel in others, so callers inferred what happened. The phase 0 port had to choose.
- **Decision:** `src/backend/select.ts` ships one `getBackendCategory` with the Rust semantics;
  the TS variant is treated as the stale copy and is not ported. `recheckOptimalBackend`,
  `refreshOptimalBackendCache` and `detectIdealBackendType` return a discriminated outcome
  (`detection_failed`, `cpu_optimal`, `already_optimal`, `no_catalog_entry`, `recommend`); the
  caller decides whether to throw `BACKEND_DETECTION_FAILED`, persist the record and emit events.
  Owner decision 2026-09-15: "единая функция в ядре, та что в TS отстала".
- **Consequences:** The only user-visible difference is that a ROCm recommendation's
  `recommendedCategory` reads `rocm` instead of `unknown`. The phase 3 adapter must map the
  outcome union back onto the extension's `null`/throw contract until the extension is removed.
  Contract fixtures for the category function come from the Rust side only.
- **Owner:** team
- **Links:** `src/backend/select.ts`, `src/backend/optimal-cache.ts`, PLAN.md §0 journal (backend port),
  app `src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs`
