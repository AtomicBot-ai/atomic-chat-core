---
date: 2026-10-15
title: "Check an upstream llama.cpp candidate only when asked: a surface diff, then live tests beside the pin on five OS"
---

# 2026-10-15 — Check an upstream llama.cpp candidate only when asked: a surface diff, then live tests beside the pin on five OS

- **Context:** a new llama.cpp release reached users once conf mirrored and approved it, and the
  only evidence behind `make upstream-approve` was "core's live tests against the candidate" — a
  nightly that had been red for weeks and installed every build under a fake tag, so no build gate
  ran against a real build. Nothing answered "is tag X compatible with this core?" in one place:
  b10875 removed `--mmap`/`--mlock`, which core survives only because its gates use the real build
  number, and core already matches strings upstream no longer prints. The update pipeline (Hatchet
  orchestrator, phase 1) needs that answer as data it can act on, and people need it without the
  orchestrator.
- **Decision:** one check, two ways to start it, both by hand (or by the orchestrator through the
  API) and never on their own:
  - `.github/workflows/engine-candidate.yml`, triggered only by `workflow_dispatch` — no schedule,
    no push or pull_request trigger, not called from `ci.yml`. Inputs `engine`, `tag` (empty: the
    newest b-tag whose archives are all up), `repo` (any repo with ggml-org's asset names; the conf
    mirror tests the signed bytes), `candidate_id` (in the run title as `[cid:…]` for the
    orchestrator), `core_ref`, `pin`, `conf_ref`, `suites` (`all` | `live`). `resolve` fixes core and
    conf to one commit each and the pin per platform from conf's release list (the release this core
    version takes today, `scripts/lib/engine-pin.mjs`, held to `upstreamRemoteBackends`); `surface`
    runs `scripts/engine-surface-diff.mjs`; `core` runs the unit, contract and e2e suites and both
    builds on five OS; `live` runs `test/live/llamacpp.test.ts` on five OS for the candidate and for
    the pin; `report` writes `results.json` (`atomic-engine-candidate-results` v1). Read-only
    permissions, no secrets, inputs only through `env`.
  - `npm run engine:check` (`scripts/engine-candidate.mjs local`): the same resolve, surface and live
    cells for this host only, from a tag, a repo + tag, or `--bin` (any local `llama-server`, tagged
    from its `--version`), into `.engine-check/`.
  - Verdict: `fail` when the candidate fails a test the pin passes (`candidate_regressions`), a test
    fails on both (`core_failures`, core's problem rather than the candidate's), a core suite fails,
    or the surface finds a `break`. `incomplete` when anything expected is missing — a cell, a
    required test (`.github/engine-candidate/llamacpp-upstream.json` names them, a test keeps the
    names real), a surface check that could not run — and whenever the release is still uploading
    archives. Only CPU builds are run; CUDA, Vulkan, ROCm and OpenCL archives are listed as not
    verified.
- **Consequences:** a candidate costs about 15 jobs (10 live, 5 core) of free public-repo minutes,
  only when someone asks. conf can gate `upstream-approve` on a passing run with the tag and a
  `cid:` in its title (conf PR6), and the orchestrator can dispatch the same workflow with an agent's
  `core_ref`; `results.json.core.protected_changes` names any file under the check's own paths that
  ref changes, so a fix that loosens the check is visible. The nightly `live-backend` of `ci.yml`
  stays as it is and is not a gate for this. The pin is the release the core version takes, which may
  differ by platform; the surface diff compares against the linux-x64 one. Forks with their own asset
  names (TurboQuant, Prism) are not covered.
- **Owner:** team
- **Links:** `.github/workflows/engine-candidate.yml`, `.github/engine-candidate/llamacpp-upstream.json`,
  `scripts/engine-candidate.mjs`, `scripts/engine-surface-diff.mjs`,
  `scripts/lib/engine-{pin,surface,results,io}.mjs`, `test/contract/engine-{pin,surface,results}.test.ts`,
  `docs/live-tests.md` ("Checking a llama.cpp build"),
  `docs/decisions/2026-10-13-read-upstream-llama-cpp-from-a-release-list.md` (the pin).
