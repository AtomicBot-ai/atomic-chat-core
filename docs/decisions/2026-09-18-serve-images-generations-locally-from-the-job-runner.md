---
date: 2026-09-18
title: "Serve /v1/images/generations locally from the job runner"
---

# 2026-09-18 — Serve `/v1/images/generations` locally from the job runner

- **Context:** The app's image-generation line added `POST /v1/images/generations` to its Rust proxy: an OpenAI-shaped facade that ran the same job as the Images page and answered with the PNG as `b64_json`. On the core-migration line the core serves `/v1` on desktop and the Rust proxy is mobile-only. Every other `/v1` route the core serves is either forwarded to an engine that speaks OpenAI itself or answered from a local listing; an image job is neither: it is a state machine with a gallery write and events, owned by `src/diffusion/`.
- **Decision:** The route is answered in the public server, never forwarded: `src/server/public/images.ts` parses the OpenAI body (`prompt`, `n` ≤ 4, `size` `WIDTHxHEIGHT` in 256–2048 by 16 or `auto`, `seed`, `negative_prompt`, `model`, and only `response_format: 'b64_json'`), binds it to the family defaults the model was loaded with, and runs it through the diffusion runner's `startImageJob` via a narrow `ImagesBackend` seam on `PublicServerDeps`. Errors take the OpenAI envelope with the plugin's mapping (400 `invalid_request`, 503 `model_not_loaded`, 429 `busy`, 500 `insufficient_memory` / `cancelled` / `server_error`, 504 `timeout` after a 30-minute ceiling); a client that goes away cancels its job. The trace reports `backend: 'atomic-diffusion'` and the endpoint `images/generations`, so the app's analytics can label it, but never announces the prompt. The image model is deliberately absent from `/v1/models`: only the resident model answers, and only when `model` is absent or names it (id or display name, with the proxy's `.`/`_` fold).
- **Consequences:** The app's `api_request_analytics.rs` needs the new endpoint and backend labels (app branch). The facade cannot report progress; a client that wants it uses the control API and the events. `/openapi.json` does not yet document the route.
- **Owner:** team.
- **Links:** `src/server/public/{images,images-params}.ts`, `src/diffusion/service.ts` (`imagesBackend`); app source `src-tauri/src/core/server/images_route.rs` at `767ff6350`.
