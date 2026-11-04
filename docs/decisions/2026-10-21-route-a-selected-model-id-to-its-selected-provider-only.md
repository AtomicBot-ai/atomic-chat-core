---
date: 2026-10-21
title: "Route a selected model id to its selected provider, or keep a locally selected one local"
---

# 2026-10-21 — Route a selected model id to its selected provider, or keep a locally selected one local

- **Context:** The public server routed by model id alone: a cloud provider that lists the id wins
  over every local session of it (`resolveRemoteProvider`, "remote wins over local"). The app keeps
  every active cloud and custom endpoint registered, and its Local API Server page shows the provider
  the user selected. QA (AC-03, app 2.2.23): a custom endpoint exposing the same id as a local model,
  used and then switched back to llama.cpp — the page said llama.cpp, `/v1/models` said
  `owned_by: remote`, and `/v1/chat/completions` went to the dead endpoint (502 `ECONNREFUSED`).
- **Decision:** The app tells the core which provider it selected for each served model id:
  `PUT /atomic/v1/server/selection` `{models: [{model, provider}]}` replaces the whole selection
  (`GET` reads it), held in memory across public-server restarts. A request for an id selected on a
  registered cloud provider goes to that provider only. An id selected on a local engine stays
  local: that engine's session is asked first, then any other local engine's in search order (the
  app and the core may name the engine differently, and both llama.cpp providers list one models
  folder); with no local session at all the answer is 503 `server_error`
  `selected_provider_unavailable` naming the model and the selected engine, and no remote provider
  is asked (`resolveSelectedRoute`, `findSelectedLocalSession`). Ids
  without a selection, or with a provider the core cannot route to (an unregistered cloud provider,
  Apple Foundation Models), keep the old rules, so an app that sends nothing behaves as before.
  `/v1/models` names each id once, by the backend its requests go to — also for an unselected id a
  remote provider owns, which no longer shows a local entry nobody reaches. The ChatGPT subscription
  branch follows the same route. Supersedes "remote wins over local" for selected ids only.
- **Consequences:** Requests follow what the app shows, or fail with an answer that says why. The
  selection is lost when the core restarts; the app hands it over again before it starts the server.
  A client that relied on reaching a cloud provider by an id the user selected a local engine for now
  gets a local engine (or the 503). Two remote providers listing one id are still decided by
  registration order, and only the first is listed; of two local engines holding a selected id the
  selected one is listed and asked.
- **Owner:** team
- **Links:** `src/router/resolve.ts` (`resolveSelectedRoute`, the doc comment of
  `resolveRemoteProvider`), `src/server/public/{forward,responses,listing,subscription}.ts`,
  `src/server/control/routes/public-server.ts`, `src/contracts/control-api.ts`; app ADR
  `2026-10-21-the-server-routes-a-model-id-to-the-provider-selected-for-it.md`.
