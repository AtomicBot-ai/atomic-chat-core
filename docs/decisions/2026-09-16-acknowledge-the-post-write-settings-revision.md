---
date: 2026-09-16
title: "Acknowledge the post-write settings revision"
---

# 2026-09-16 — Acknowledge the post-write settings revision

- **Context:** The app mirrors provider settings at revision `R` and acknowledges `R`. Writing the acknowledgement increments the settings file to `R+1`, but the status route compared the stored `R` to `R+1` and immediately reported `in_sync:false`. A compiled-binary E2E exposed the failure after an owner restart.
- **Decision:** Keep every file mutation revisioned. Accept an acknowledgement only if its input revision is still current, then store the post-write revision `R+1` as the equivalent mirrored state. A retry of the same acknowledgement is a no-op while nothing else has changed; a stale acknowledgement after a value change is rejected.
- **Consequences:** `/settings/status` reports `in_sync:true` immediately after a successful mirror and remains true across owner restarts. Any later settings change advances the revision and makes it false again. Existing on-disk records with the old acknowledgement convention remain readable and fail closed until the app mirrors and acknowledges the current revision. The route and request shape are unchanged, but callers must not interpret `acknowledged_revision` as the pre-write revision they submitted. Skipping the revision bump for metadata was rejected: it would let a settings file change invisibly to revision-based readers.
- **Owner:** team.
- **Links:** `src/settings/store.ts`, `src/settings/store-import.test.ts`, `test/e2e/owner.test.ts`, `docs/app-e2e.md`.
