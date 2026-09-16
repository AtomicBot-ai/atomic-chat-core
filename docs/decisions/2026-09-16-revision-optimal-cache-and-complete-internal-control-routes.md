---
date: 2026-09-16
title: "Revision optimal cache and complete internal backend and embedding routes"
---

# 2026-09-16 — Revision optimal cache and complete internal backend and embedding routes

- **Context:** During stage 3c–3d the app and CLI could both choose an optimal backend, but a flat cache file and webview `localStorage` offered no ordering or conflict detection. The core also owned backend downloads and model sessions without exposing cancellation or batched embeddings to the app.
- **Decision:** The core loads the old flat cache at startup and thereafter owns a per-provider monotonic revision in an atomically replaced file. `GET /backends/:provider/optimal` returns `{optimal, revision}`; `PUT` requires `expected_revision`, returns 409 with the current state on conflict, and publishes `backend:optimal-changed` only after the file commit. The registration/snapshot includes `optimal_backends` at its event cursor. Internal control routes `POST /downloads/*taskId/cancel` and `POST /models/:provider/*modelId/embed` complete core ownership of downloads and embeddings. Installation accepts an ephemeral proxy policy for the live manifest and both archive transfers; credentials are never persisted. These are paired app/core routes, not additions to the public `:1337/v1` API.
- **Consequences:** A stale app detection cannot overwrite a newer CLI answer; a recovering app takes a snapshot before consuming subsequent changes. Mutating calls remain non-retryable after an ambiguous transport failure. Old cache files remain readable, but moving a data folder to different hardware is **not** detected by this revision alone and needs a separate invalidation rule. Embedding 501 recovery unloads and reloads in embedding mode at most once per request.
- **Owner:** team.
- **Links:** `src/backend/optimal-store.ts`, `src/backend/service.ts`, `src/models/embed.ts`, `src/server/control.ts`, `PLAN.md` §4 (3c–3d).
