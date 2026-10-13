---
date: 2026-10-13
title: "Read upstream llama.cpp from a release list that names the oldest core each release runs on"
---

# 2026-10-13 — Read upstream llama.cpp from a release list that names the oldest core each release runs on

- **Context:** the `llamacpp-upstream` catalog came from conf's `backends/manifest.json`, one tag for
  every core. Any commit there reached every installed core at its next start: an engine update that
  needed a core change could not be held back from the cores without it, and a bad tag could not be
  withdrawn from a running core, because the manifest was held for the whole session (no TTL). An
  install of any tag but the manifest's came from the ggml-org CDN, unsigned and unhashed.
- **Decision:** the core reads conf's `backends/llamacpp-upstream-releases.json`, newest release
  first, in the PrismML manifest's shape: each release names its `min_core_version` and may be
  `withdrawn`, each archive is `candidate` or `approved` with its sha256 and size. Each backend comes
  from the newest release this core meets whose archive is approved (a candidate too with
  `llamacpp-upstream`'s new `allow_candidate_builds`). `UpstreamReleasesCatalogService` keeps the
  list for an hour and on disk (`<data>/llamacpp-upstream/releases.cache.json`). When the list answers
  but cannot be read (a 404 before conf publishes it, a newer `schema_version`, a body that is not
  JSON), the legacy `backends/manifest.json` serves as one release every core runs (`source:
  legacy-manifest`); after a transport failure the legacy fetch is skipped. Then the disk copy, then
  the bundled `upstream-releases-baseline.json`. Every listed tag installs from the signed mirror
  against its hash, offered or not.
- **Consequences:** conf lists a release that needs a core change with that core's version, and only
  cores from that version take it; older cores, which read only `backends/manifest.json`, keep the
  release conf points that file at, which conf's check keeps to one every core runs
  (`min_core_version` 0.0.0). A withdrawal or approval reaches a running core within the hour. A pack
  already installed from a withdrawn release stays and is not moved off it (deferred). The session
  manifest cache, `fetchLiveManifest`, `fetchRemoteBackends` and the hand-copied
  `bundled-manifest-baseline.ts` are gone; the baseline is now a copy of conf's list, re-copied when
  a release is approved there. Catalog `source` values are unchanged.
- **Owner:** team
- **Links:** `src/backend/catalog/upstream-releases{,-catalog,-baseline}.ts`, conf
  `backends/llamacpp-upstream-releases{,-schema}.json` and `.github/scripts/upstream-releases.mjs`,
  `docs/decisions/2026-10-05-prismml-provider-compatibility-gate-and-model-setup.md` (the shape).
