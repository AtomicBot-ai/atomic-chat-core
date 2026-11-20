---
date: 2026-11-20
title: "Resolve a minor-less family id when an engine update targets only a variant"
---

# 2026-11-20 — Resolve a minor-less family id when an engine update targets only a variant

- **Context:** The "Latest <variant>" dropdown and the persisted `version_backend` use minor-less GPU
  family ids (`win-cuda-13-x64`, `linux-cuda-13-x64`, `win-rocm-x64`), because ggml-org bumps the
  CUDA toolkit and HIP minors between releases. `LlamacppEngine.target` used to look a variant-only
  `POST /engines/:engine/update` target up in `catalog.available` by strict string equality, so a
  family id never matched the catalog's concrete asset (`win-cuda-13.5-x64`) and the update was
  refused with `BACKEND_TAG_UNRESOLVED` (HTTP 500) for a build the catalog does publish. The rest of
  the core already resolves this case: `resolveLatestVersionBackend` matches an exact id first and
  then picks the newest concrete member of the family, as `UPSTREAM_POLICY.resolveSentinel` and the
  app's `resolveLatestBackendString` do.
- **Decision:** A variant-only update target resolves through `resolveLatestVersionBackend(variant,
  catalog.available)` and the resulting `<version>/<backend>` is parsed by the existing `parseKey`.
  A variant the catalog truly lacks still raises `BACKEND_TAG_UNRESOLVED` with the same code,
  message shape and details.
- **Consequences:** Updates chosen from the "Latest CUDA/ROCm" entries install the newest concrete
  family build instead of failing; an explicit `<version>/<variant>` target keeps its exact meaning
  and gets no family rewrite. The refusal for an unknown or hardware-ineligible variant is unchanged.
- **Owner:** team
- **Links:** `src/engines/llamacpp.ts`, `src/backend/catalog/cuda-family.ts`,
  `src/engines/llamacpp-family-target.test.ts`, Sentry issue ATOMIC-CHAT-CORE-DM.
