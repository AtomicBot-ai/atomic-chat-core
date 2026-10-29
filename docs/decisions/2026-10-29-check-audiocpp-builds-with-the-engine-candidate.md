---
date: 2026-10-29
title: "Check audio.cpp builds with the engine candidate workflow"
---

# 2026-10-29 — Check audio.cpp builds with the engine candidate workflow

- **Context:** the core now installs audio.cpp (`audiocpp_server`) as the engine build `audio-cpp`, from
  conf's `backends/audiocpp-manifest.json`. conf mirrors and signs a build into a release
  `vX.Y.Z[-a<rev>]`, stages it in `backends/audiocpp-manifest.staging.json`, and its approval
  (`audiocpp-approve.yml`) asks the engine candidate gate for a `results.json` with
  `engine: audio-cpp`, `candidate.repo` conf and `candidate.tag` the tag, `status: pass` — as it does for
  sd.cpp ([2026-10-21](2026-10-21-check-sdcpp-builds-with-the-engine-candidate.md)). Without a check
  for audio.cpp no build could pass that gate. audio.cpp's builds are the same kind of release as
  sd.cpp's — one archive per backend id over the same vocabulary, cut from an upstream tag, a conf
  manifest instead of a release list — but its tags carry no commit, its archives are named by the
  tag rather than the commit (and differently by the fork and upstream), it has one binary whose
  `--help` lists its HTTP routes, and its install probe reads `--version`.
- **Decision:** `engine-candidate.yml` takes `engine=audio-cpp`. `.github/engine-candidate/audio-cpp.json`
  (`kind: audiocpp`) holds what differs, read by the same scripts:
  - **One release machinery for both engines.** sd.cpp's archive, completeness, install-manifest, fetch
    and report-assembly code takes a release spec (`SDCPP_RELEASE` in `scripts/lib/sdcpp-surface.mjs`:
    the project name, how a tag reads, what a contract archive pattern names for a tag, the part of a
    name that says which build it is, conf's manifest parser); audio.cpp passes `AUDIOCPP_RELEASE`
    (`scripts/lib/audiocpp-surface.mjs`). sd.cpp's exports and messages are unchanged wrappers. The
    scripts pick by `kind` from small tables instead of `kind === 'sdcpp'` branches; conf's sd.cpp and
    audio.cpp pins are one `resolveGgmlPins` in `scripts/lib/engine-pin.mjs` with the tag as the only
    difference, as `parseGgmlReleaseManifest` is in the core.
  - **Tags** `vX.Y.Z(-a<rev>)`, as `AUDIOCPP_TAG_RE` in `src/engine-builds/manifest.ts`; upstream side
    tags (`v0.9.2-drama3-base-small`) are refused. The candidate's `commit` is 0xShug0's tag's
    (`git ls-remote`); there is no short commit in the tag to compare it with.
  - **Candidates** are the fork's release (`AtomicBot-ai/audio.cpp`, the default repo), conf's mirror
    (`-a<rev>`, checked against the staging manifest exactly as sd.cpp's), and upstream's own release
    (`0xShug0/audio.cpp`, the bootstrap path). **The pin** is the live manifest's `tag_name`, from conf
    (`pin_repo`); until the first approval there is none.
  - **The contract** (`test/fixtures/audiocpp/engine-contract.json`), by hand: the flags core passes
    (`--config --no-ui --host --port --backend --threads --log --load-progress`) and the routes it calls
    (`GET /health`, `GET /v1/models`, `POST /v1/audio/speech`, `POST /v1/tasks/run`,
    `GET /v1/audio/voices`), all `break`; `--help`, `--version` and `--list-devices`, `warn` on their exit
    (the probe reads output); the probe's `audio.cpp ` marker; the version and commit patterns of
    `--version`; the archives by backend after conf's `mirror-audiocpp.yml`, each pattern taking the
    fork's and upstream's name under `{version}` (the bare tag, on the `-a<rev>` mirror too); and the
    0xShug0 server sources, with the routes as the quoted paths the dispatcher compares.
    `test/contract/audiocpp-engine-contract.test.ts` holds it to the v0.9.3 help screen and
    `--version`, to `parseAudioVersion`, to both conf manifests and to `audiocppHostChoice`.
    `win-cuda13-x64`, which the fork builds and conf mirrors, is left out: the ladder never picks it.
  - **The surface** reads the flags as whole tokens of the usage block and the option lines (never a
    flag a help text only mentions, so `--log-file` and "with --log/--log-file" never stand for `--log`)
    and the routes with their methods from `Endpoints:`; `--version` must name the tag's `X.Y.Z`
    (`break`), a commit other than the upstream tag's is a `warn` (the fork applies its patches without
    committing them, so today it is the tag's), a build without a version (`dev`) a `warn`. Fewer than
    15 flags or 5 routes fails closed.
  - **Live** runs `test/live/audio-install.test.ts` on linux-x64, linux-arm64 and macos-arm64
    (`macos-15`; both the fork's and upstream's macOS builds target 13.3), CPU archives only: the build
    installed through a manifest the fetch writes from the release (`ATOMIC_AUDIOCPP_MANIFEST_URL`), a
    tampered sha256 refused, `--version` naming the tag's version. Without
    `ATOMIC_LIVE_AUDIO_MANIFEST` it installs conf's bootstrap staging manifest. The fetch also brings
    Kokoro-82M q8 (189 MB, pinned by Hugging Face revision and sha256) and fills `ATOMIC_LIVE_AUDIO_*`
    (`ENGINE TAG MANIFEST MODEL FAMILY TASK MODE BACKEND`) for the runtime's live tests, which join
    `live_files` and `required_live_tests` when they land; it writes the build's `--help`, `--version`
    and `--list-devices` beside them, the shape of `test/fixtures/audiocpp/v<version>/`. The live
    timeout is 30 minutes.
- **Consequences:** a check of an audio.cpp build is three core jobs and three live jobs (no pin until
  the first approval). Upstream's own builds cannot pass: 0xShug0 publishes no Linux or Windows arm64
  build, so the surface breaks on those CPU archives and the linux-arm64 cell has nothing to fetch; the
  bootstrap approval of upstream v0.9.3 therefore needs conf's override, and the fork's builds are the
  ones the gate backs. On this machine (macOS arm64, M4 Pro)
  `npm run engine:check -- --engine audio-cpp --repo 0xShug0/audio.cpp --tag v0.9.3` resolves, runs the
  surface (help, routes, version and probe pass) and the live install (3/3 in 6 s), and fails only on
  those two archives. Kokoro does not speak on upstream's builds (no eSpeak-ng), which the runtime's
  live tests will show. Metal, CUDA, Vulkan and Windows are not run (`not_verified`). A core release
  without `.github/engine-candidate/audio-cpp.json` cannot check audio.cpp.
- **Owner:** team
- **Links:** `.github/engine-candidate/audio-cpp.json`, `.github/workflows/engine-candidate.yml`,
  `scripts/lib/{audiocpp-surface,audiocpp-fixtures,sdcpp-surface,sdcpp-fixtures,engine-io,engine-pin,engine-surface}.mjs`,
  `scripts/{engine-candidate,engine-surface-diff,fetch-live-fixtures}.mjs`,
  `test/fixtures/audiocpp/{engine-contract.json,releases/}`,
  `test/contract/{audiocpp-engine-contract,audiocpp-surface,engine-pin,engine-results,engine-surface}.test.ts`,
  `test/live/audio-install.test.ts`, `docs/live-tests.md` ("audio.cpp builds"); atomic-chat-conf
  `mirror-audiocpp.yml`, `audiocpp-approve.yml`, `.github/scripts/upstream-verify.mjs` (`GATES['audio-cpp']`).

<!--
Refines: 2026-10-21-check-sdcpp-builds-with-the-engine-candidate.md (the release machinery is shared)
-->
