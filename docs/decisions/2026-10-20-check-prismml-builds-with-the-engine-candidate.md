---
date: 2026-10-20
title: "Check PrismML builds with the engine candidate workflow, as upstream ones are checked"
---

# 2026-10-20 — Check PrismML builds with the engine candidate workflow, as upstream ones are checked

- **Context:** the engine candidate check
  ([2026-10-15](2026-10-15-check-an-engine-candidate-only-when-asked.md)) covered upstream llama.cpp
  only; forks with their own tags were left out. PrismML's fork (`PrismML-Eng/llama.cpp`, the
  `atomic-prism` provider) publishes a build one to three times a week, and each was added to conf's
  `atomic-prism-manifest.json` by hand and approved after a manual run on real hardware. The engine
  update pipeline (atomic-hatchet-pipeline) now updates PrismML the way it updates upstream: check,
  agent verdict, list in conf, check again at the latest core release, approve. It needs the same
  `results.json` for a PrismML build.
- **Decision:** `engine-candidate.yml` takes `engine=atomic-prism`. Everything that differs from
  upstream is data in `.github/engine-candidate/atomic-prism.json`, read by the same scripts:
  - `tag_pattern` `prism-b<N>-<sha7>`; `<N>` is the upstream build the fork is cut from, what
    `--version` prints and what the build gates see (`engineTagBuild` reads both shapes).
  - `default_repo` and `upstream` (`PrismML-Eng/llama.cpp`, branch `prism`) for the archives and the
    history; the contract is upstream's (`test/fixtures/llamacpp/engine-contract.json`): the fork runs
    the same `llama-server` surface core drives.
  - `pins: prism-manifest`: the pin per platform from conf's PrismML manifest, as
    `prismCatalogToBackends` offers it (`resolvePrismPins`, held to the TypeScript by
    `test/contract/engine-pin.test.ts`).
  - `mirror: false`: conf does not mirror PrismML (core downloads from the fork and checks the listed
    sha256), so no whitelist is checked and a release is complete once each platform's CPU archive is up.
  - `live_files` `test/live/prism.test.ts` with `live_model` `Ternary-Bonsai-1.7B-PQ2_0.gguf`
    (pinned by revision and sha256) and `live_env_prefix` `ATOMIC_LIVE_PRISM`: the install gate
    (`verifyPrismBackendBinary`), `-h` against the contract, and a load on `atomic-prism` that answers.
    Platforms linux-x64, macos-arm64 and windows-x64; macOS x64 and the GPU packs are `not_verified`.
  - The workflow's `repo` input defaults to the engine's own repo; `ENGINE` reaches every job.
- **Consequences:** a PrismML build is checked on three OS for the candidate and the pin (about six live
  jobs plus the core suites) and gets the same verdict codes as upstream. The first green live run on
  macOS arm64 (prism-b10787 against prism-b10754, pin prism-b10777 on that platform) took seconds per
  cell once the 463 MB GGUF was cached. The check runs from `core_ref`'s scripts, so a core release
  before this one cannot check PrismML: the pipeline looks for `.github/engine-candidate/atomic-prism.json`
  on the release and waits for the next one. Approval now follows a passing run, not real-hardware
  acceptance; GPU packs go out with the CPU ones (the pipeline's choice, as for upstream). The core's
  offline `prism-manifest-baseline.json` is still re-copied by hand.
- **Owner:** team
- **Links:** `.github/engine-candidate/atomic-prism.json`, `.github/workflows/engine-candidate.yml`,
  `scripts/lib/engine-{io,pin,surface}.mjs`, `scripts/fetch-live-fixtures.mjs`, `test/live/prism.test.ts`,
  `test/contract/engine-{pin,surface}.test.ts`, `docs/live-tests.md` ("PrismML builds"); atomic-chat-conf
  `prism-add.yml` / `prism-approve.yml`; atomic-hatchet-pipeline `docs/engine-updater.md`.

<!--
Refines: 2026-10-15-check-an-engine-candidate-only-when-asked.md (forks were out of scope; PrismML is now covered)
-->
