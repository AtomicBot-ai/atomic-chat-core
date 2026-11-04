---
date: 2026-11-04
title: "Scope binary failures to the engine release"
---

# 2026-11-04 — Scope binary failures to the engine release

- **Context:** Blacklisting an engine family until a GPU driver update also hid fixed engine releases after a broken binary, missing DLL or unexplained crash. Users with an installed CPU alternative could stay on CPU indefinitely.
- **Decision:** GPU_BACKEND_INCOMPATIBLE remains keyed by provider, backend and driver. Other failures also match the engine release tag. Keep distinct failed releases instead of replacing their records, and use this rule consistently in configured selection, automatic selection, fallback and the advisor catalog. A new driver clears the applicable records as before.
- **Consequences:** Updated binaries can restore acceleration on the same driver, while old failed releases remain blocked. Confirmed GPU incompatibility continues to suppress the family across releases. No file schema change is needed: reason and version are already stored.
- **Owner:** `team`.
- **Links:** PR #75, `src/backend/select/bad-backends.ts`, `src/backend/install/runtime-backend.ts`, `src/backend/advisor/advisor.ts`.
