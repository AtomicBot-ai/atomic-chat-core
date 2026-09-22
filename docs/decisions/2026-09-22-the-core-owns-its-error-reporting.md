---
date: 2026-09-22
title: "The core owns its error reporting"
---

# 2026-09-22 — The core owns its error reporting

- **Context:** `2026-09-21-report-core-errors-to-its-own-sentry-project.md` tied reporting to the Atomic Chat app:
  - the DSN was baked into `atomic-chat-app-core` only;
  - the CLI never reported;
  - a daemon launched without `--telemetry` reported nothing;
  - all context (hardware tags, user id) came from the app.

  The core is meant to serve other hosts too — the CLI, other programs that import it, future apps — and should report its own failures wherever it runs.
- **Decision:**
  1. **DSN in the source.** The DSN of `atomic-chat/atomic-chat-core` lives in the source (`CORE_SENTRY_DSN`); a DSN is a public ingest key, like the one in every shipped binary. Every build can report:
     - the app's daemon as host `atomic-chat`;
     - the CLI daemon and `launch --standalone` as `cli`;
     - `AtomicCore.create()` as `library`, or the name the embedding program gives in `telemetry.host`.

     Release builds stamp environment `production` and the commit into both binaries. Everything else reports as `source`. An explicit DSN (build secret, `ATOMIC_CORE_SENTRY_DSN`) still wins, and `development` still turns reporting off.
  2. **Consent is decided by the core** (`resolveConsent`), in this order:
     1. an "off" from the environment (`DO_NOT_TRACK`, `ATOMIC_CORE_TELEMETRY=off`), which beats everything;
     2. the host (`--telemetry on|off` on either daemon, `PUT /atomic/v1/telemetry`, `AtomicCore.create({ telemetry: { enabled } })`);
     3. an environment "on";
     4. the user's stored choice (`atomic-chat-core telemetry on|off`);
     5. otherwise **on**.

     A host that says nothing leaves reporting on; a host "off" turns it off. `telemetry: false` removes the reporter from a library core altogether. `GET /telemetry` now says who decided (`source`) and for whom (`host`).
  3. **`<data>/atomic-core/telemetry.json` holds the core's own state** for that data folder:
     - the stored choice;
     - an anonymous `install_id` (the report's user when the host names none), written only when something could be reported;
     - whether the one-time CLI notice was shown.
  4. **The core describes the machine itself.** It adds OS release, CPU model and RAM from `node:os`, so a report is useful without any host. A host's tags still win on the same key.
  5. **The CLI tells the user once per data folder** (`daemon`, `serve`, `launch`) when it reports only by default, and how to turn it off. Process-level handlers belong only to a core that owns its process: the app daemon and the CLI daemon. A library leaves its host's process alone.
  6. **Nothing from tests or development reaches the project.** The built-in DSN is never used under a test runner (`VITEST`, `NODE_ENV=test`, in the injected or the real environment). The app passes `--telemetry off` in a build whose own Sentry is off (a `tauri dev` session, a test build). Its live tests run the core in `development`.
- **Consequences:**
  - Reporting no longer depends on the app, and any host can turn it off.
  - A developer running a local CLI build reports as `source` unless they set `DO_NOT_TRACK=1` or `telemetry off`. The notice tells them so.
  - The project's quota is shared with the app's projects; the per-process caps (5 per issue, 50 per hour) and the DSN key's rate limit are the guard.
  - Supersedes, in `2026-09-21-report-core-errors-to-its-own-sentry-project.md`:
    - "the DSN is baked into the app's binary only";
    - "the CLI binary never reports";
    - "a missing flag means off".
- **Owner:** team.
- **Links:**
  - `src/telemetry/{config,consent,store,core-reporter}.ts`, `src/cli/commands/telemetry.ts`, `src/cli/commands/daemon.ts`, `src/core/create.ts`, `test/e2e/telemetry.test.ts`.
  - App: `src-tauri/src/core/telemetry/mod.rs` (`core_consent`).
