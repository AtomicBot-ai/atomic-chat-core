---
date: 2026-10-21
title: "Check stable-diffusion.cpp builds with the engine candidate workflow"
---

# 2026-10-21 — Check stable-diffusion.cpp builds with the engine candidate workflow

- **Context:** the engine candidate check
  ([2026-10-15](2026-10-15-check-an-engine-candidate-only-when-asked.md),
  [2026-10-20](2026-10-20-check-prismml-builds-with-the-engine-candidate.md)) covered llama.cpp builds
  only. The engine update pipeline (atomic-hatchet-pipeline) now updates stable-diffusion.cpp too: the
  Atomic fork (`AtomicBot-ai/stable-diffusion.cpp`) builds each leejet tag `master-<N>-<sha7>`, conf
  signs it into a release `master-<N>-<sha7>-a<rev>` and stages it in `backends/sdcpp-manifest.staging.json`,
  and approval moves it into `backends/sdcpp-manifest.json`, which every core installs from (no
  `min_core_version`). The pipeline reads only `results.json`, and needs one for both runs: the fork's
  build at `core_ref=main`, and the signed mirror at the core release, the workflow started from that
  release's ref. Nothing in the llama.cpp check fits sd.cpp as it is: other binaries, another help
  format, archives named by the commit rather than the tag, a manifest instead of a release list, and a
  model that is several files.
- **Decision:** `engine-candidate.yml` takes `engine=sd-cpp`. `.github/engine-candidate/sd-cpp.json`
  (`kind: sdcpp`) holds what differs, read by the same scripts:
  - Tags `master-<N>-<sha7>(-a<rev>)`, as `SDCPP_TAG_RE` in `src/engine-builds/manifest.ts`. The
    candidate's `commit` is the leejet tag's (`git ls-remote`); `results.json` adds `upstream_tag`
    and `atomic_rev` to the candidate, and `manifest` on conf.
  - **Complete** means every archive conf's mirror requires and the CPU archive of each live platform
    is up exactly once with GitHub's digest; on conf, also a manifest naming the tag (staging, or the
    live one when that is the one naming it) whose sizes and sha256 equal the release's and whose
    `download_base` is conf. A staging manifest that moved on to another tag leaves the run
    `incomplete`, never checks something other than what would be approved.
  - **The pin** is the live manifest's `tag_name` on each platform whose CPU archive it pins
    (`resolveSdcppPins`, held to `parseSdcppManifest` and `sdcppHostChoice` by
    `test/contract/engine-pin.test.ts`); its archives come from conf (`pin_repo`), the only place a
    `-a<rev>` tag exists.
  - **The contract** (`test/fixtures/sdcpp/engine-contract.json`) is written by hand and held to the
    code by `test/contract/sdcpp-engine-contract.test.ts`: the flags of `required-flags.txt` plus `-v`
    (`break`), `-M` (`warn`: emitted only when opted in, and sd-server does not have it); `sd-server
    --help`, `--version` and `sd-cli --help`; the probe markers of `install.ts`; the routes and the
    progress, out-of-memory, abort and GPU-fault text core reads; the archives by backend, after conf's
    `mirror-sdcpp.yml` and the backend ladder; and the leejet sources they live in.
  - **The surface** (`scripts/lib/sdcpp-surface.mjs`) writes the same `atomic-engine-surface-report`
    v1 with sd.cpp's checks. Flags are matched as whole aliases, so `--vae-format` never stands for
    `--vae`; an exit code is a `warn` (the probe reads output, not exit codes) and a probe binary
    without a marker a `break`; `--version` has to name the tag's commit (the fork's builds say
    `version unknown`, an `info`). The history is leejet's between the two tags, cloned from leejet and
    shallowed by the dates of leejet's releases; the git cache is now one folder per upstream repo.
  - **Live** runs on linux-x64, linux-arm64 and macos-arm64 (no Windows: the image test skips win32,
    and every run would stay `incomplete`), on the CPU archives, pin and candidate. FLUX.2 Klein 4B
    Q4_K_M with Qwen3-4B-Instruct-2507 Q4_K_M as `--llm` and the FLUX.2 VAE — conf's catalog files, 5.4
    GB, pinned by Hugging Face revision and sha256 (`live_models`) — in a cache entry of their own keyed
    by those hashes, on a path Linux and macOS share, so one copy fits GitHub's 10 GB. SD-Turbo, the
    fork's own smoke model, cannot be used: core passes `--diffusion-model`, and sd.cpp then prefixes
    the checkpoint's VAE and CLIP tensors with `model.diffusion_model.` and fails to tell its version
    (seen on master-883: `get sd version from file failed`). `ATOMIC_DIFFUSION_BACKEND=cpu`, a new
    narrow switch in `DiffusionService`, starts every load with `--backend cpu`: the live run sets it,
    because a macOS runner's paravirtual GPU crashes ggml's Metal kernels. The new
    `test/live/diffusion-install.test.ts` installs the release through a manifest of conf's shape
    (`ATOMIC_SDCPP_MANIFEST_URL`): pick, download, sha256, unpack, probe, a tampered sha256 refused,
    and `--version` naming the tag's commit. macOS runs on `macos-26`: the fork's macOS archive is built
    with `minos 26.0`.
  - The core suites run on the engine's platforms (`core_matrix` from resolve, `core_runner` where it
    differs from the live runner); the pipeline keeps `suites=all`. For llama.cpp the matrix is the
    same seven jobs as before. The live job's timeout comes from the config (`live_timeout_minutes`:
    90 for sd.cpp; GitHub's 360 otherwise). Required live tests may name `platforms`.
- **Consequences:** a check of an sd.cpp build is three core jobs and six live jobs; the first run
  downloads 5.4 GB per live job, later ones restore it. On this machine (macOS arm64, M4 Pro, CPU
  backend) `npm run engine:check -- --engine sd-cpp --tag master-883-137f740` passes against the pin
  `master-883-137f740-a36f1b1a` in 9 minutes, about 4 minutes of them per generation test; a 3- or
  4-core runner is expected to take several times longer, inside the 90-minute timeout. A core release older than this one has no
  `.github/engine-candidate/sd-cpp.json`, so the pipeline holds an sd.cpp rollout until a core release
  carries it. Metal, CUDA, Vulkan, ROCm and Windows are not run (`not_verified`). The macOS runner has 7
  GB of memory for 5.4 GB of weights; if it pages too much, the live timeout says so. `-M` and three
  deprecated flags core still emits (`--qwen2vl`, `--clip-on-cpu`, `--vae-on-cpu`) make every surface
  report a `warn` until core moves off them. The `generating video:` line the tracker waits for is not
  printed by leejet at master-883; the report lists it as text in neither tree.
- **Owner:** team
- **Links:** `.github/engine-candidate/sd-cpp.json`, `.github/workflows/engine-candidate.yml`,
  `scripts/lib/{sdcpp-surface,sdcpp-fixtures,engine-io,engine-pin,engine-results,live-fixtures}.mjs`,
  `scripts/{engine-candidate,engine-surface-diff,fetch-live-fixtures}.mjs`,
  `test/fixtures/sdcpp/engine-contract.json`, `test/contract/sdcpp-{engine-contract,surface}.test.ts`,
  `test/live/diffusion{,-install}.test.ts`, `src/diffusion/{args,service}.ts`, `docs/live-tests.md`
  ("stable-diffusion.cpp builds"); atomic-chat-conf `mirror-sdcpp.yml` / `sdcpp-approve.yml`;
  atomic-hatchet-pipeline `docs/engine-updater.md`.

<!--
Refines: 2026-10-15-check-an-engine-candidate-only-when-asked.md (sd.cpp is now covered)
-->
