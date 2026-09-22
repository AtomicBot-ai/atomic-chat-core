---
date: 2026-09-21
title: "Report core errors to its own Sentry project"
---

# 2026-09-21 — Report core errors to its own Sentry project

- **Context:** The app reports errors to two Sentry projects (app ADR `2026-06-09-add-zero-pii-sentry-crash-error-tracking-to-both-the-react.md`, ATO-113). `atomic-chat-desktop` saw backend failures through the Rust `log::error!` bridge. Since the core replaced that backend, nothing reports:
  - the daemon itself crashing, or failing to start (only `core-start.log` has it);
  - bugs behind the HTTP boundary;
  - engines crashing after they loaded;
  - model loads from the public API, remote clients or the CLI;
  - image-model loads and image jobs;
  - compute failures mid-request.

  The web app reports only loads started from its UI, and with no engine context.
- **Decision:**
  1. **Its own project, no SDK.** The core reports to its own project, `atomic-chat-core`, in the app's organisation, using hand-built envelopes over `fetch` (`src/telemetry/`). `@sentry/node` needs loader hooks that a single-file compiled binary cannot provide, and runtime dependencies are fixed (AGENTS.md §3.8). The model is `atomic-agent/src/error-reporting/`, with stack frames sent oldest first.
  2. **Only the app's binary reports.**
     - `atomic-chat-app-core` gets the DSN baked in at release: `bun build --define`, from the `ATOMIC_CORE_SENTRY_DSN` secret. The build fails if the DSN did not land in the binary.
     - The CLI binary never reports.
     - `ATOMIC_CORE_SENTRY_DSN` and `ATOMIC_CORE_SENTRY_ENVIRONMENT` override the baked values for local checks. The `development` environment turns reporting off.
     - Release is `atomic-chat-core@<version>`; `dist` is the commit.
  3. **Consent is the app's `productAnalytic`.**
     - At launch the app passes `daemon --telemetry on|off`. If the flag is absent, reporting is off.
     - Afterwards, `PUT /atomic/v1/telemetry {enabled?, user_id?, tags?}` carries what the app's `set_telemetry_*` commands learn. `GET` answers `{enabled, reporting, has_user, tags}`.
     - All of this is kept in memory only.
     - The flag mirrors the app's Rust gate. That gate is on until the webview reconciles the persisted value, which is the same window the app already accepts for Rust panics.
  4. **What is reported**, each case built by a pure function in `reports.ts`:
     - **Uncaught exceptions and unhandled rejections: `fatal`.** The handler writes the error to stderr, sends the report, waits up to 2 s, then exits 1. Without that exit, Bun would keep running after a capture-only rejection handler.
     - **Start-up failures: `fatal`.** Losing the lock race (`CORE_ALREADY_RUNNING`) is not reported.
     - **Uncoded errors behind a ≥ 500 answer: `error`.** On the control server the report carries the route pattern and never the path. On the public server it carries neither. Clients that hang up are not reported.
     - **Throwing event listeners: `error`.**
     - **`session:died`.** A native crash is an `error`. An outside kill or an OOM exit is a `warning`. A polite stop is not reported.
     - **Failed loads, from any caller: `["model-load-failure", provider, code]`.**
       - Cancellations, the codes the user can fix themselves (`RECOVERABLE_LOAD_ERROR_CODES`) and refusals made before any engine starts are not reported.
       - Environment causes are reported at `warning`.
       - The report carries the backend, context size and quantisation.
     - **Image model loads and image jobs.** Codes that name something fixable are not reported.
     - **Compute failures of a live engine: `warning`.** Any other 5xx from an engine is an `error`.

     Engine errors now come only from the core; the web app stops capturing local model-load failures. Downloads and context overflow stay with the web app.
  5. **Zero-PII.** The rules of the app's `scrub.rs` apply, plus:
     - the data folder becomes `<data>` and the home folder becomes `~`;
     - tunnel hosts, e-mail addresses, IPv4 addresses and more token shapes are masked.

     Beyond that:
     - An exception value is the first line only, at most 200 characters.
     - Engine output is sent as marker lines only (errors, asserts, failures), never lines that look like prompts or JSON bodies. At most 20 lines and 2 KB are sent.
     - Tags are allow-listed (`SENTRY_TAG_KEYS` of the web app for the app's own tags) and short.
     - No `server_name`, no IP, no local variables, no URLs, no bodies.
  6. **Noise.**
     - Identical events are deduplicated for 60 s.
     - Caps: 5 events per issue per hour, 50 events in total per hour.
     - A crash loop is throttled per (model, code) for 5 minutes, as the web app does.
     - Sentry's `429` / `Retry-After` is honoured.
     - Sending is fire-and-forget with a 5 s timeout.
  7. **Build.**
     - `--minify-syntax --minify-whitespace` replaces `--minify`. Function names survive, so grouping stays stable across releases (`--keep-names` does not help: Bun's frames use the minified identifier). The binary grows by 0.2 MB of 65 MB.
     - The embedded source map already maps frames back to `src/…:line:col`, so no source maps are uploaded.
     - Bun is pinned to 1.3.10 in CI and release, because stack parsing depends on its format.
- **Consequences:**
  - A release built without the secret reports nothing.
  - The app may pass `--telemetry` only to a core that knows the flag (`parseArgs` is strict), so both sides ship together in 0.3.0.
  - Every report scrubs against the data folder, which the daemon learns from `--data-folder`.
  - A CLI owner answers `/telemetry` with the "not reporting" state.
- **Owner:** team.
- **Links:**
  - `src/telemetry/`, `src/app-daemon.ts`, `src/server/control/routes/telemetry.ts`, `scripts/build-binaries.mjs`, `test/e2e/telemetry.test.ts`.
  - App: `src-tauri/src/core/telemetry/`, `src-tauri/src/core/atomic_core/{launch,telemetry}.rs`, `web-app/src/utils/switchModel.ts`.
