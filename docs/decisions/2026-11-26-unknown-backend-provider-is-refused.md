---
date: 2026-11-26
title: "Refuse an unknown backend provider at the control route"
---

# 2026-11-26 — Refuse an unknown backend provider at the control route

- **Context:** `GET /atomic/v1/backends/:provider` (and the install, optimal and remove routes beside
  it) passed the raw path segment straight into the backend service. `src/core/create.ts` cast that
  string to `LocalProviderId` and `src/backend/installed/scan.ts` called `layout.provider(provider)`
  before any check; `DataLayout.provider` is an exhaustive switch with no runtime guard, so a value
  outside the union returned `undefined` and reading `paths.backendsDir` threw a `TypeError`. The
  caller saw HTTP 500 with `INTERNAL_ERROR` instead of a refusal, on every release that carries this
  route (Sentry ATOMIC-CHAT-CORE-3A, releases 0.7.5, 0.9.9 and 0.20.4).
- **Decision:** validate the `:provider` segment once per pack handler with a local `localProvider`
  helper that rejects a value missing from `LOCAL_PROVIDER_IDS` with `PROVIDER_NOT_FOUND`, before the
  string reaches `BackendControl`. The advisor routes keep their own `isLlamacppProviderId` check,
  because the advisor knows a narrower set than the pack routes.
- **Consequences:** an unknown provider is now a 404 `PROVIDER_NOT_FOUND` with the available ids in
  the details, matching what `/models/:provider` and the settings store already answer. Known ids
  behave exactly as before (an empty list when the provider has no backends directory). The layout
  keeps no runtime guard of its own: the boundary is the control route, where untrusted strings
  enter, and one check there covers list, install, both optimal routes and remove.
- **Owner:** core team.
- **Links:** `src/server/control/routes/backends.ts`,
  `src/server/control/routes/backends-unknown-provider.probe.test.ts`, `src/config/paths.ts`,
  `src/backend/installed/scan.ts`.
