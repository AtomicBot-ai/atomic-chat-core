---
date: 2026-09-28
title: "The app core writes its own log file"
---

# 2026-09-28 — The app core writes its own log file

- **Context:** The Tauri app keeps `app.log`, but the detached `atomic-chat-app-core` process has no log
  of its own once the app disconnects:
  - **App reads the core's stderr pipe and writes it to `app.log`.** Rejected: the core is detached and
    outlives the app. After a reconnect there is no pipe any more, and `detachableWriter` mutes stderr for
    good on the first `EPIPE` — the exact bug commit `8286e0b` fixed.
  - **App subscribes to the SSE `core:log` event and writes it to `app.log`.** Rejected for three reasons:
    lines are lost while the app is not connected (start, crash, restart); engine output would push
    lifecycle events out of the 1000-event replay ring; and `core:log` today does not even carry
    `CoreLogger`'s own lines.
  - A file the core writes itself survives every restart, and the app can read it even with the core dead.
- **Decision:**
  1. **The core writes `<data>/atomic-core/logs/core.log` to disk; the app reads it.** This is the already-
     defined `layout.core.logsDir` from `PLAN.md`. A new `--log-dir` flag to write next to `app.log` in
     `<data>/logs` was rejected: it adds an argument to the binary's contract, and the app already knows
     the path through `lock::core_dir(data_folder)`. Both folders are in `JAN_DATA_SUBDIRS`, so a factory
     reset clears both; "Show in folder" still opens only `<data>/logs`, so log hand-off stays the export.
  2. **One line and timestamp format for `app.log` and `core.log`:** `[YYYY-MM-DD][HH:MM:SS][target][LEVEL]
     message`, UTC, to the second — the format `app.log` already uses, now shared by `core.log`, by every
     line `atomic-chat-app-core` writes to stderr (which the app keeps as `core-start.log`), and by the
     export, with a source field added there. A multi-line message carries the header on its first line
     only. Local time everywhere, UTC files with a local window, JSON lines and millisecond precision were
     each considered and rejected on the app side (unambiguous ordering across time-zone changes, symbol-
     for-symbol match between the window and the exported file per the GATE 1 owner ruling, human
     readability, and not having to touch `app.log`'s existing format and parsers). One parser serves both
     sources.
  3. **Rotation at 5 × 10 MiB, named like `tauri-plugin-log`'s archives:** `core_YYYY-MM-DD_HH-MM-SS.log`,
     so the app can find either source's archives with one rule (`<stem>_*.log`, sorted by name,
     descending). The writer is a small internal module on `node:fs`, `src/host/log-file.ts`, not exported
     from `src/host/index.ts` or the package: a pure `formatLogLine(date, target, level, message)` builds
     every header (used by both the file and stderr), writes are synchronous, and rotation closes the file
     descriptor *before* the rename — a file a process holds open cannot be renamed on Windows. Any error
     writes one `WARN` line to stderr and disables the writer for the rest of the process, the way
     `detachableWriter` disables itself. `pino` and `rotating-file-stream` were rejected as new runtime
     dependencies; synchronous writes were chosen so lines stay ordered and nothing is lost on a crash.
  4. **Engine output reaches a log through a new `AtomicCoreOptions.backendOutput` option**, typed
     `(e: { provider, model, stream: 'stdout' | 'stderr', line }) => void`. `create.ts` wires it into
     `LlamacppRuntime` (both providers), `MlxRuntime`, `FoundationModelsRuntime`, and the diffusion
     module's `spawnServer` (`provider = spec.engine`, `model = spec.modelId`); each runner calls it from
     its existing `onLine`/`deliver` path, in addition to `logPath`/`verbose`, never instead. A sink that
     throws is swallowed after one `warn` through the runner's logger per engine session
     (`backendOutputReporter` in `src/runtime/shared/backend-output.ts`), so a broken sink cannot take a
     model load down. Setting `logPath` on every load (a separate, unrotated file per load) and extending
     `CoreLogger` with a `debug` level were both rejected — the first leaves the app searching N files, the
     second would change a public callback's type and hand engine output to `atc` and Sentry breadcrumbs.
     Without `backendOutput`, behaviour is unchanged, keeping "the CLI and embedding are unaffected."
  5. **The engine-start line** (`starting <exe basename> for <provider>/<model>: <args>`) is a new
     `log('info', …)` call added to each of the three local runners (llama.cpp, MLX, Foundation Models),
     with `--api-key` masked by a new shared helper, `redactArgs` (`src/runtime/shared/redact-args.ts`),
     handling both the two-token and `--api-key=<v>` forms. The diffusion module already logged
     `starting sd-server: …` at `info` before this change and needed no new line; only its per-line output
     is new, through `backendOutput`.
  6. **Only the app binary assembles a file log.** `atomic-chat-app-core`'s logic — argument parsing,
     opening `core.log`, tee-ing the core's logger and `backendOutput` to stderr and the file, dubbing
     `failFatally`'s reason into the file, headering the reporter's `warn` lines and the process's fatal
     handlers — moved out of the top-level-await script `src/app-daemon.ts` into an exported
     `runAppDaemon(deps)` in `src/host/app-daemon.ts` (also not re-exported from `src/host/index.ts`).
     `src/app-daemon.ts` stays the build entry — `scripts/build-binaries.mjs`'s `APP_ENTRY` and
     `docs/app-e2e.md`'s source-mode command both name that path — and now only wires up the real process,
     clock, reporter and core and hands them to `runAppDaemon`. The move exists purely for unit-testability:
     a script that runs via top-level `await` at import time cannot be driven by a test with fake `argv`,
     `io`, a scripted clock and a fake core the way `src/host/app-daemon.test.ts` does; splitting entry from
     logic is the same shape every other binary entry in this repo already uses. The CLI binary's `daemon`
     command (`src/cli/commands/daemon.ts`) is untouched: its stderr stays `[level] message`, and it writes
     no log file.
  7. **The contract is pinned from the core's side** (design D9): `docs/contracts.md` documents `core.log`
     next to the format, rotation and stderr rules above; `test/fixtures/core-log/sample.log` fixes a
     header, a multi-line continuation and both engine stream prefixes; `test/contract/core-log.test.ts`
     writes that fixture byte-for-byte through the real `openLogFile`/`formatLogLine` machinery. The core is
     the source of truth for this fixture — the reverse of most sets under `test/fixtures/app/` — and the
     app names this repo's commit when it copies the fixture into its own `core::logs` tests.
- **Consequences:**
  - `core.log` and `core-start.log` read the same way, by eye or by one parser, and stay legible after a
    crash because every write is synchronous and ordered.
  - Heavy engine output can fill 10 MiB quickly; 50 MiB of history stays on disk across 5 files, and the
    limits are constants that can be raised on their own without a contract change.
  - A rotation that races a reader (Windows) or a second app-core instance mid-handover is not fatal: the
    writer keeps appending to the current file and retries rotation on the next write, at worst leaving one
    extra archive.
  - `AtomicCoreOptions.backendOutput` and `redactArgs` are new, tested surface any embedder can also use;
    absent it, behaviour is exactly what it was before this change.
  - Second-precision timestamps mean app and core lines within the same second need a deterministic merge
    rule (app first, then core, source order preserved within each) rather than a true interleave;
    millisecond precision would be a separate, larger format change touching `app.log`'s writer and every
    parser of it.
- **Owner:** team.
- **Links:**
  - `src/host/log-file.ts` (`formatLogLine`, `openLogFile`, `MAX_LOG_BYTES`, `MAX_LOG_ARCHIVES`),
    `src/host/log-file.test.ts`.
  - `src/host/app-daemon.ts` (`runAppDaemon`), `src/host/app-daemon.test.ts`, `src/app-daemon.ts` (thin
    entry).
  - `src/runtime/shared/backend-output.ts` (`BackendOutputSink`, `backendOutputReporter`),
    `src/runtime/shared/redact-args.ts` (`redactArgs`).
  - `src/core/types.ts` (`AtomicCoreOptions.backendOutput`), `src/core/create.ts` (wiring into the four
    runners), `src/runtime/{llamacpp,mlx,foundation-models}/runtime.ts`, `src/diffusion/server-process.ts`.
  - `docs/contracts.md` (`core.log` row), `test/fixtures/core-log/sample.log`,
    `test/contract/core-log.test.ts`, `test/e2e/app-core-log.test.ts`.
  - App: an ADR of the same title under the app repo's `docs/decisions/`, and `core::logs` for the copied
    fixture (design D9 of `add-unified-logs`).
