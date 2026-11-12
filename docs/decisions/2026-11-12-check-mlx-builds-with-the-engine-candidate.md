---
date: 2026-11-12
title: "Check MLX builds with the engine candidate workflow"
---

# 2026-11-12 — Check MLX builds with the engine candidate workflow

- **Context:** the core installs `mlx-server` (the mlx-vlm server frozen with PyInstaller, macOS arm64
  only) from conf's `backends/mlx-manifest.json`, which was edited by hand. The engine update pipeline
  now builds each Neywa-Labs/mlx-vlm release in the Atomic fork (`AtomicBot-ai/mlx-vlm`, release
  `vX.Y.Z`: the archive `mlxvlm-mlx-server-macos-arm64.tar.gz`, signed and notarized, and
  `requirements.lock.txt`), and conf's `mirror-mlx.yml` copies it byte for byte into the conf release
  `mlxvlm-macos-arm64-<rev>`, stages it in `backends/mlx-manifest.staging.json` (with the new optional
  `upstream_tag`), and `mlx-approve.yml` asks the engine candidate gate for a `results.json` with
  `engine: mlx`, `candidate.repo` conf and `candidate.tag` the tag, `status: pass` — as for sd.cpp and
  audio.cpp ([2026-10-29](2026-10-29-check-audiocpp-builds-with-the-engine-candidate.md)). MLX differs
  from those: one archive whose name carries no tag, one platform, no `--version`, and released cores
  accept only `tag_name` `mlxvlm-macos-arm64-<hex>`, so the fork's own release cannot be installed under
  its name.
- **Decision:** `engine-candidate.yml` takes `engine=mlx`. `.github/engine-candidate/mlx.json`
  (`kind: mlx`) holds what differs, read by the same scripts:
  - **The release machinery is sd.cpp's** with MLX's spec (`MLX_RELEASE` in
    `scripts/lib/mlx-surface.mjs`): tags `vX.Y.Z` or `mlxvlm-macos-arm64-<hex>`, the archive pattern
    without a tag, conf's MLX manifest (`parseMlxPinManifest`, a mirror of `parseMlxManifest` held to it
    by `test/contract/engine-pin.test.ts`) with the download base its `upstream_repo` implies. The fetch
    takes three optional hooks of its spec (no version argv, a longer capture timeout, conf's MLX manifest
    as the install manifest) and records what the archive unpacked to.
  - **Candidates:** the fork's `vX.Y.Z` (default repo), conf's mirror (staging manifest checked exactly as
    sd.cpp's), and the fork's older `mlxvlm-macos-arm64-<hex>` releases. A conf build's upstream tag is
    the manifest's `upstream_tag`; an older fork build has none, and then nothing is compared upstream.
    **The pin** is the live manifest's `tag_name`, fetched from its `upstream_repo` (the pin sources may
    now say where the pin is downloaded from: `pins.repo`), since the live manifest names the fork until
    conf's mirror approves a first build.
  - **The contract** (`test/fixtures/mlx/engine-contract.json`), by hand: the flags `buildMlxServerArgs`
    passes, with the choices of `--draft-kind` and `--kv-quant-scheme`, all `break`; `--help` as the one
    invocation, `break` on its exit (the install probe needs exit 0) with a 120 s timeout
    (`MLX_PROBE_TIMEOUT_MS`); the probe's `usage: mlx-server`; the archive holding `mlx-server` alone; the
    env the runtime sets; the routes core forwards to and `MLX_VLM_MAX_TOKENS` as upstream strings; and
    `mlx_vlm/server/` as a watched **folder**: a watched path ending in `/` now stands for every file
    under it in the surface (stats, presence, commits, release notes, strings).
    `test/contract/mlx-engine-contract.test.ts` holds it to `--help` of the pin and of v0.7.12, to
    `mlxProbePassed`, `mlxHostChoice`, the runtime and conf's manifests.
  - **The surface runs on macOS** (`surface_runner: macos-15`, a new resolve output with
    `ubuntu-latest` as the default): there is no Linux build to run.
  - **Live** runs on `macos-15` (Metal; `verified: ["metal"]`, a config field that replaces the fixed
    `cpu`), candidate and pin: `test/live/mlx.test.ts` (`--help` against every flag and choice, a load
    through the core with the build as its resources dir, a chat, and a json_schema `response_format`
    that must come back as schema-following JSON, the regression a bundle without its structured-output
    engine has) and the new `test/live/mlx-install.test.ts` (installed from the manifest the fetch writes,
    a tampered sha256 refused, ordered by `published_at`). The model is SmolLM2-135M-Instruct 8-bit, the
    fork's smoke model: `live_models` may now name a folder (`files`, each pinned by sha256 under a
    revision-pinned base URL), cached by the digest of its files. Install tests carry a `tag_pattern`:
    `requiredLiveTests` asks them only of `mlxvlm-macos-arm64-<hex>` builds, and the test skips a
    `vX.Y.Z` manifest, which no core reads.
- **Consequences:** a check of an MLX build is one core job, one surface job and two live jobs, all on
  macOS. The fork's `vX.Y.Z` build is checked without the install path (its archive, layout and probe are
  in the surface instead); conf's mirror of it, which the approval gates on, runs the install tests. Until
  conf's `main` has `upstream_tag` the pin names no upstream tag and the history is not compared. On this
  machine (M4 Pro), `npm run engine:check -- --engine mlx --tag v0.7.12 --conf <conf checkout>` against
  the pin `mlxvlm-macos-arm64-07ba5a1` passes: surface warn (a `remove` commit in the server folder), the
  pin 6/6 live, the candidate 3/3 with the install tests skipped. The fork's older
  `mlxvlm-macos-arm64-89acca5` against the same pin fails as it should: its bundle lacks llguidance,
  and mlx-server answers the json_schema request with a 400 (`candidate_regression`). Drafts, KV
  quantization and vision
  models are not run (`not_verified`). A core release without `.github/engine-candidate/mlx.json` cannot
  check MLX.
- **Owner:** team
- **Links:** `.github/engine-candidate/mlx.json`, `.github/workflows/engine-candidate.yml`,
  `scripts/lib/{mlx-surface,mlx-fixtures,sdcpp-fixtures,engine-io,engine-pin,engine-results,engine-surface,live-fixtures}.mjs`,
  `scripts/{engine-candidate,engine-surface-diff,fetch-live-fixtures}.mjs`, `test/fixtures/mlx/`,
  `test/contract/{mlx-engine-contract,mlx-surface,engine-pin,engine-results,engine-surface,live-fixtures}.test.ts`,
  `test/live/{mlx,mlx-install}.test.ts`, `docs/live-tests.md` ("MLX builds"); atomic-chat-conf
  `mirror-mlx.yml`, `mlx-approve.yml`, `.github/scripts/upstream-verify.mjs` (`GATES.mlx`); the fork's
  `release-atomic.yml` and `atomic/ci/smoke.py`.

<!--
Refines: 2026-10-29-check-audiocpp-builds-with-the-engine-candidate.md (the release machinery is shared)
-->
