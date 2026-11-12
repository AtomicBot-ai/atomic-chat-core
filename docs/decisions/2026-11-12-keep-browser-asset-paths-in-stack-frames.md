---
date: 2026-11-12
title: "Browser stack frames keep their served asset path"
---

# 2026-11-12 — Browser stack frames keep their served asset path

- **Context:** Web-admin reports like `web-admin browser.react: unknown` ([Sentry issue 7843672158](https://us.sentry.io/organizations/atomic-chat/issues/7843672158/)) arrived with a bare `index-CQHL6z4L.js` filename: `framePath` cut the served `/assets/<file>` path down to the basename, so the trusted controller's release rebuild could not match the asset to its source map and every position stayed minified.
- **Decision:** `framePath` (`src/telemetry/stack.ts`) keeps a trailing `assets/<file>` segment. The origin is stripped before the frame is built; `assets/<file>` names the served artifact and carries no machine, user or session context. Frames under a compiled `dist/assets/` keep their `dist/` prefix, because the `src/`/`dist/` cut runs first; a local `assets/` directory loses its parent path the same way a user folder does.
- **Consequences:** Browser frames arrive as `assets/index-*.js`, and the pipeline's controller (`agent/sentry/browser_maps.py`) matches them to rebuilt sources. `in_app` stays `false`, and the `src/`, `node_modules` and native rules are unchanged.
- **Owner:** team
- **Links:** Sentry issue 7843672158, `src/telemetry/stack.ts`, atomic-hatchet-pipeline `agent/sentry/browser_maps.py`
