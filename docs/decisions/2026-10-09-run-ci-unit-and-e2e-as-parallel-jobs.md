---
date: 2026-10-09
title: "Run CI's unit and e2e suites as parallel jobs, and split the watchdog script tests"
---

# 2026-10-09 — Run CI's unit and e2e suites as parallel jobs, and split the watchdog script tests

- **Context:** A green `ci.yml` took ~8.5 min, and `release.yml` runs the same workflow before it
  publishes.
  - `gate` (lint, typecheck, format) ran first and the five-OS `test` matrix waited for it, although
    the tests use nothing it produces.
  - Each `test` job then ran unit+contract, the Bun suites, the build and the e2e suites one after
    another, so an OS's time was their sum: macOS ~3.5 min coverage + ~2.7 min e2e.
  - Locally and on the POSIX runners, `npm test` could not finish before
    `src/runtime/container/watchdog.test.ts`. Its 27 entrypoint-script tests run real `/bin/sh` timing
    one after another inside one file, ~64 s, while the other 437 files took ~20 s on 13 workers.
- **Decision:**
  - `gate`, `unit` and `e2e` start together, with no `needs` between them. `unit` holds unit+contract
    (coverage and its floor check on macOS) and the Bun suites. `e2e` holds the build, `build:bin`, the
    e2e suites and the binary artifact.
  - The live jobs need all three.
  - The watchdog script tests move into four `watchdog.script-*.test.ts` files, grouped by scenario and
    balanced by measured time (~14–17 s each). They share `test/helpers/watchdog-harness.ts`, with a
    per-test temp dir instead of the module-level one. Test names and count are unchanged (45), and
    `watchdog.test.ts` keeps the unit blocks.
- **Consequences:**
  - An OS's CI time is the slower of its two jobs, and a lint failure no longer holds back the tests.
  - `release.yml` still publishes only after every job of the reusable workflow passed.
  - Costs: ten test jobs instead of five, each with its own checkout and `bun install`. A red lint no
    longer saves the matrix's runner minutes.
  - Local `npm test`: 64 s → 32 s, now bounded by `src/diffusion/service.test.ts` (~30 s).
  - Windows is unaffected by the split: the script tests are POSIX-only.
  - Vitest's worker count is unchanged; raising it is a separate, measured experiment.
- **Owner:** team
- **Links:** `.github/workflows/ci.yml`, `src/runtime/container/watchdog.script-*.test.ts`,
  `test/helpers/watchdog-harness.ts`,
  [CI run of 2026-10-08](https://github.com/AtomicBot-ai/atomic-chat-core/actions/runs/37756605255).
