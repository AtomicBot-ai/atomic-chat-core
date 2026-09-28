---
date: 2026-09-27
title: "The core advises on backends for both llama.cpp providers; the app decides when to act"
---

# 2026-09-27 — The core advises on backends for both llama.cpp providers; the app decides when to act

- **Context:** The pure selection policy had been ported (`src/backend/select/*`, `optimal/optimal-cache.ts`,
  `turboquant.ts`) but nothing in the core called it: the app's extensions still ran `detectIdealBackendType`,
  `recheckOptimalBackend`, `checkBackendForUpdates` and the TurboQuant `fetchStableIndex`, and only stored the
  result (`PUT /backends/:p/optimal`) and installed through the core. The two extensions had drifted (VRAM floor
  `6 * 1024` inline in one, `GPU_BACKEND_MIN_VRAM_MIB` in the other; different "already optimal" rules).
- **Decision:** A `BackendAdvisor` per provider composes the existing pure functions over the core's own
  hardware facts and answers three questions on `/atomic/v1/backends/:provider/`: `POST catalog` (features,
  supported ids, remote + installed + hardware-gated `available`, `recommended`, `recommended_installed`,
  `latest_by_type`, `static_variants`; the fork adds `releases`), `POST recommendation` (`mode: refresh|recheck`;
  detection under a 20 s guard, concrete resolution, the optimal record built with the provider's policy and
  **persisted by the core** in its revisioned store; `backend:better-detected` emitted on `recommend`) and
  `POST updates` (`update_needed`, `same_family`, `offer`; a missing `version_backend` answers "no update"
  instead of throwing). All three are POST because the proxy policy may carry credentials and never travels in a
  query string. `detection_failed` is a 200 outcome, not an error. The core does not install, does not write
  `version_backend`, does not run a schedule: the app keeps its startup policy, hot-swap, dropdown and banner.
  Both providers are covered; the TurboQuant release catalog (index.json → `/releases/latest` redirect → legacy
  manifest → disk cache, 1 h TTL) moves into the core and keeps writing `<data>/llamacpp/release-index.cache.json`
  in the shape the install path reads. The per-provider differences are kept verbatim: 2 GiB vs 6 GiB VRAM floor,
  Windows CUDA-12 driver floor 551.61 vs 527.41, "already optimal" by type+category vs category, `no_catalog_entry`
  clearing the record (upstream) vs keeping it (fork), upstream Linux = Vulkan/CPU only. Deliberate changes:
  `recheck` forces a catalog refresh for both providers (the fork did, upstream did not); the app mirrors the
  optimal record from the response instead of writing it. A `setting-update` route is deferred: the pure
  `handleSettingUpdate`/`shouldMigrateBackend` are exported and the app keeps a local parse helper.
- **Consequences:** One selector for every host; the CLI can list, recommend and check updates. The app's
  `recheck`/`refresh` become one call each and must not PUT after detection (it would race the core's own write
  and get a 409). The core emitting `backend:better-detected` means the app must not relay it into
  `onBetterBackendDetected` as well. A cold fork detection can trip the 20 s guard once while its three 8 s catalog
  steps warm the cache, as in the app. Moving a data folder to other hardware is still not detected by the record
  (ADR 2026-09-16).
- **Owner:** team.
- **Links:** `src/backend/advisor/`, `src/backend/catalog/turboquant-{index,catalog}.ts`,
  `src/backend/select/turboquant-tiers.ts`, `src/contracts/backend-advisor.ts`,
  `src/server/control/routes/backends.ts`, `src/cli/commands/{backends,hardware}.ts`,
  `test/e2e/backend-advisor.test.ts`; app: `extensions/{shared,llamacpp-upstream-extension,llamacpp-extension}`.
