---
date: 2026-09-16
title: "Test stage 3 through hermetic process boundaries"
---

# 2026-09-16 — Test stage 3 through hermetic process boundaries

- **Context:** A mocked control server and mocked Tauri IPC passed the stage-3 unit suites while real owner recovery, archived backend installation and persisted migration state were not exercised together. External release mirrors make a CI e2e test nondeterministic.
- **Decision:** Drive the compiled core with real HTTP/SSE, a temporary data folder and an isolated TLS mirror reached through a local CONNECT proxy. Drive the app's Rust supervisor and relay against that same compiled core, with live tests opt-in. Keep these process tests distinct from a real desktop-UI test: a mocked IPC callback or a fake backend is not evidence that the webview received or rendered an event.
- **Consequences:** The default core binary gate checks a manifest-pinned mirror checksum, fallback URL, install/cancel/progress, settings conflict/persistence and embedding reload without downloading a release. The Windows gate additionally installs a CUDA companion zip; POSIX-only fake llama-server sessions are skipped on Windows, where the separate real-backend job must cover spawning. The app's live gate checks automatic start/recovery, generation, snapshot/delta ordering and restart ceiling. Neither gate proves the UI progress bar, rollback controls or RAG screen; those still require an isolated desktop-UI runner and live acceptance before stage 4. A newly exposed `settings/status.in_sync` failure deliberately keeps the binary gate red until the migration invariant is repaired.
- **Owner:** team.
- **Links:** `test/e2e/owner.test.ts`, `test/helpers/backend-install-e2e.ts`, `../Atomic-Chat/src-tauri/src/core/atomic_core/live_tests.rs`, `docs/app-e2e.md`.
