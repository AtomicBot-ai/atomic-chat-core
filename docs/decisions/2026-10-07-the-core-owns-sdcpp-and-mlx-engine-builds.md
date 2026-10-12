---
date: 2026-10-07
title: "The core owns the sd.cpp and MLX engine builds: manifest, install, update and removal"
---

# 2026-10-07 — The core owns the sd.cpp and MLX engine builds: manifest, install, update and removal

- **Context:** The core ran `sd-server` and `mlx-server` but could not get them. For stable-diffusion.cpp the
  desktop read conf's `backends/sdcpp-manifest.json`, picked a build with `backendMatrix.ts` over the deprecated
  Rust `get_supported_features`, downloaded and unpacked straight into the target folder, then called
  `POST /diffusion/backends/finalize` and retired the other builds itself (ADR 2026-09-17: "downloading the
  engine archive … stays in the app"). An update was any other tag, an older one included, and a cancel from the
  downloads panel did not reach the download. `mlx-server` existed only inside the desktop installer
  (`resources/bin`, pinned in the Makefile, no hash check). `atc` ships no engines, so it could install neither.
  Openspec change `move-sdcpp-mlx-install-to-core`.
- **Decision:** A module of its own, `src/engine-builds/`, installs both engines from conf's manifests
  (`sdcpp-manifest.json`, the new `mlx-manifest.json`) behind `/atomic/v1/engine-builds/:engine/{catalog,updates,
  install}` and `DELETE …/:tag/:backend_id`, with `engine-build:changed {engine, reason}`. It follows ADR
  2026-09-27: the core advises (catalog, update check), the client decides when to install; nothing installs on a
  schedule. An install is synchronous under the caller's `task_id` (progress and cancel are the existing
  `download:*` events and `POST /downloads/:task_id/cancel`), refuses a parallel one (`ENGINE_INSTALL_IN_PROGRESS`)
  and never moves an engine back (`active-is-newer`, even with `force`). Every archive is pinned by `sha256` and
  `size` from the manifest, unpacked into `<target>.incoming-<now>`, probed (`sd-cli`/`sd-server --help`,
  `mlx-server --help`), marked and recorded, and only then renamed into place. The new build is activated under
  the engine's load lock (sd.cpp's `loadLock`, MLX's load queue), which unloads sessions of another build, and the
  other downloaded builds are retired unless a session still runs from them. sd.cpp keeps the app's selection
  ladder verbatim, arm64 builds and the walk down the ladder on a failed probe included (pairs remembered in
  `<data>/diffusion/failed-backends.json`). MLX runs the newer, by `published_at`, of the installer's
  `mlx-server` (described by `mlx-server.json`, never removed) and the ones the core downloaded under
  `<data>/mlx/backends`; at start the downloads no newer than the installer's are removed. The three diffusion
  backend routes and `finalizeDiffusionBackend`, `listDiffusionBackends`, `removeDiffusionBackend` are removed.
- **Consequences:** The desktop and `atc` install the same way, and no unverified tree lands in the data folder:
  the second install path `finalize` gave is gone (breaking for `@atomic-chat/core/client`; its only user, the
  desktop, moves in the same change). The core now fetches two more conf documents (cached on disk, overridable by
  `ATOMIC_SDCPP_MANIFEST_URL` / `ATOMIC_MLX_MANIFEST_URL`) and downloads from `leejet/stable-diffusion.cpp`, the
  conf mirror and `AtomicBot-ai/mlx-vlm`. A downloaded `mlx-server` carries the fork's signature
  (`disable-library-validation` only), not the app's re-signing; whether it runs generation on a clean Mac is the
  change's gate check (rulings/core.md 2.1). Builds the desktop installed with `finalize` carry the same marker and
  record and are recognised without a migration. The cancelled install is not resumed; its staging is removed.
- **Owner:** `team`.
- **Links:** `src/engine-builds/`, `src/server/control/routes/engine-builds.ts`, `src/contracts/engine-builds.ts`,
  `test/e2e/engine-builds.test.ts`; openspec `move-sdcpp-mlx-install-to-core` (design D1–D10, rulings/core.md).

Supersedes: the "Downloading the engine archive and the model files stays in the app … the core finalizes an
unpacked tree, lists and removes" part of
[2026-09-17-image-generation-is-its-own-module-not-a-local-runtime.md](2026-09-17-image-generation-is-its-own-module-not-a-local-runtime.md)
for the engine binary; model files still download in the app. Follows
[2026-09-27-the-core-advises-on-backends-the-app-decides.md](2026-09-27-the-core-advises-on-backends-the-app-decides.md).
