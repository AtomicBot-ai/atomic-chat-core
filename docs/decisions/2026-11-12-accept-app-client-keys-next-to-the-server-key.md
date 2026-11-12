---
date: 2026-11-12
title: "Accept the app's client keys next to the server key"
---

# 2026-11-12 — Accept the app's client keys next to the server key

- **Context:** Account remote access in the desktop app gives every paired device its own key for the public `/v1` API. The app's Rust owns pairing, crypto and key minting; the core owns the public listener and the Cloudflare tunnel. The core already has a keyring (`AtomicCoreOptions.publicApiKeys`), but only an embedder can set it: the app daemon (`src/host/app-daemon.ts`) starts the core as a separate process and has no way to hand it a callback. The keyring also replaces the listener's `api_key` outright and turns a keyless listener into a keyed one, which is not what the app wants: its server key must keep working for local tools, and sharing must never close an open server.
- **Decision:** Add `PUT /atomic/v1/server/client-keys` `{keys: string[]}`, which replaces an in-memory list of extra keys (at most 200, each 20–256 characters of `[A-Za-z0-9._~-]`) and answers only `{count}`. For each request, the public listener accepts `[api_key, ...clientKeys]` when it has a non-empty `api_key` and the host keeps no keyring. In every other case nothing changes: an embedder keyring still wins, and a keyless listener stays open.
- **Consequences:** The app's server key stays authoritative, and `requires_api_key`, `serverHasApiKey` and the idempotent-start comparison still depend on it alone. All account remote-access logic stays in the app; the core only checks keys. The list is read on every request, so a revoked device is refused on its next request. The list survives listener restarts but not core restarts, so the app sends it again on every change and every reattach (`atomic-core://snapshot`). The route has no read-back. Keys never appear in a response, a snapshot, `GET /server`, `LocalApiServerState`, a log or telemetry. Revisit if the core itself has to persist keys or if embedders need both a keyring and extra keys.
- **Owner:** `team`
- **Links:** `src/server/control/routes/public-server.ts`, `src/server/public/index.ts` (`acceptedKeys`), `src/core/atomic-core.ts` (`setClientKeys`), `src/client/control-client.ts` (`setServerClientKeys`), ADR `2026-11-07-reuse-public-api-with-host-keyring.md`, app PR AtomicBot-ai/Atomic-Chat#410
