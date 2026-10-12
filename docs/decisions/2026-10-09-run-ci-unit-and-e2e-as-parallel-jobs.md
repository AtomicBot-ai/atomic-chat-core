---
date: 2026-10-09
title: "Run CI's unit and e2e suites as parallel jobs, and split the watchdog script tests"
---

# 2026-10-09 — Run CI's unit and e2e suites as parallel jobs, and split the watchdog script tests

- **Context:** A green `ci.yml` took 7.5 min on main `f058148`, and `release.yml` runs the same
  workflow before it publishes.
  - `gate` (lint, typecheck, format) ran first, and the five-OS `test` matrix waited for it, although
    the tests use nothing it produces.
  - Each `test` job then ran its suites one after another, so an OS's time was their sum:
    unit+contract, the Bun suites, the build, then the e2e suites. windows-11-arm took 6.7 min and
    macOS 6.0 min.
  - The Windows unit run alone took 3.5–4 min, twice any other OS's.
  - macos-14 has 3 vCPUs, and Vitest forks one fewer worker by default.
  - Locally and on the POSIX runners, `npm test` could not finish before
    `src/runtime/container/watchdog.test.ts`. Its 27 entrypoint-script tests run real `/bin/sh` timing
    one after another inside one file, ~64 s, while the other files took ~20 s on 13 workers.
- **Decision:**
  - **Jobs.** `gate`, `unit` and `e2e` start together, with no `needs` between them. The live jobs need
    all three.
    - `unit` holds unit+contract (coverage and its floor check on macOS) and the Bun suites.
    - `e2e` holds the build, `build:bin`, the e2e suites and the binary artifact.
  - **Windows shards.** On windows-2022 and windows-11-arm, unit+contract runs in two jobs,
    `--shard=1/2` and `2/2`. Vitest splits by file; the shards together run the same 461 files and 8412
    tests. The seconds-long runtime-compat and Bun suites run once per OS, with the first shard.
  - **macOS workers.** On macos-14, unit and e2e run with `VITEST_MAX_FORKS=3`. The coverage command
    and its floor check are unchanged.
  - **Bun cache.** `unit` and `e2e` restore bun's package cache (`~/.bun/install/cache`), keyed by
    `bun.lock`.
  - **Watchdog split.** The watchdog script tests move into four `watchdog.script-*.test.ts` files,
    grouped by scenario and balanced by measured time (~14–17 s each). They share
    `test/helpers/watchdog-harness.ts`, with a per-test temp dir instead of the module-level one. Test
    names and count are unchanged (45), and `watchdog.test.ts` keeps the unit blocks.
- **Consequences:**
  - **Time.** A green run takes ~3.2–3.3 min instead of 7.5 on the same code (three PR runs: 198 s,
    190 s, 198 s). The slowest jobs are now windows-11-arm's unit shard and its e2e, ~3 min each.
  - Measured job by job:
    - Windows unit test time per job: 238 / 210 s → ~120 / ~112 s;
    - macOS unit: 187 → 144 s;
    - macOS e2e: 154 → 106 s;
    - `bun install` on windows-2022: ~21 → ~3 s.
  - A lint failure no longer holds back the tests; `release.yml` still publishes only after every job
    of the reusable workflow passed.
  - **Costs.** 13 jobs instead of 6, each with its own checkout and install, so a red lint no longer
    saves the matrix's runner minutes. More forks on macOS also mean more contention for timing-based
    tests; watch them, and fix such a test rather than lowering the forks again.
  - Local `npm test`: 64 s → ~33 s, now bounded by `src/diffusion/service.test.ts` (~30 s). Windows is
    unaffected by the watchdog split: the script tests are POSIX-only.
  - The `threads` pool was tried and dropped: two tests depend on per-process state, and it was no
    faster.
- **Owner:** team
- **Links:** `.github/workflows/ci.yml`, `src/runtime/container/watchdog.script-*.test.ts`,
  `test/helpers/watchdog-harness.ts`, PR #16;
  baseline [run 38042845579](https://github.com/AtomicBot-ai/atomic-chat-core/actions/runs/38042845579).
