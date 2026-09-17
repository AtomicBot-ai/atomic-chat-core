# Running the Tauri app against this core (app-e2e)

Goal: prove the app-owned core and the independent CLI core each preserve their own state and lifecycle (PLAN.md §5.1, "App-E2E").

## Prerequisites

- `../Atomic-Chat` checked out next to this repo, `make dev` run once there.
- This repo built: `npm run build && npm run build:bin`.
- Bun on PATH (source mode only).

## Modes

| Mode | How the app finds the core | Use |
| --- | --- | --- |
| Binary | `resources/bin/atomic-chat-app-core` (after `yarn download:core` in the app) | release-like runs |
| Source | `ATOMIC_CORE_CMD="bun run ../atomic-chat-core/src/app-daemon.ts" yarn dev` in the app | launcher only; app appends `daemon` and arguments |

Flags in the app: `ATOMIC_CORE_RUNTIME=off|llamacpp-upstream|all`, `ATOMIC_CORE_SERVER=legacy|core`
(env overrides of `<data>/store.json` keys `atomic_core.runtime` / `atomic_core.server`).

## Scenarios (each maps to an exit criterion in PLAN.md §4)

1. **Namespace isolation** — app and CLI simultaneously have different PID, lock, models, backends,
   credentials and state files. CLI `--data-folder` equal to the canonical app folder fails; its default
   lives in `<system data>/atomic-chat-cli/data`. No old files are moved or copied.
2. **argv parity** — same inputs produce equivalent backend argv after explicit dynamic-field normalization
   (PLAN.md §5.1); test the intentional CLI detach-on-Ctrl+C change separately.
3. **UI load → sessions** — load a model in the app UI; `GET /atomic/v1/sessions` matches what
   `model-factory.ts` resolved (port, api_key).
4. **auto-increase-ctx** — overflow the context from the proxy path and from the agent path; both recover.
5. **Backend install** — install/update/"find optimal" from the UI; progress and completion events reach the UI.
6. **Flag round-trip** — transfer `atomic_core.runtime` off → llamacpp-upstream → off with no active conflicting
   operation, unload, revision acknowledgment and settings preservation. Reject unsupported flag combinations.
7. **External clients** — Codex (`/responses`), Claude Code (`/messages`), OpenCode (`/chat/completions`) against `:1337`.
8. **Independent startup** — app and CLI in either order start separate owners. A model loaded in one
   does not appear in the other. Shutting down one leaves the other's PID, lock and model untouched.
9. **App exit and CLI persistence** — hiding the app to the tray leaves its models serving; full exit
   unloads them and releases its lock. A crashed app owner expires after its registration; restart does
   not attach to an old version or kill a process without proven start identity. CLI survives command exit
   until explicit `shutdown`; an idle old daemon upgrades, but active clients prevent replacement.
10. **Independent listeners** — stop/start or change public host/port while control, sessions and SSE remain
    reachable. A failed legacy/core public-server transfer restores the previous owner or reports stopped.
11. **Recovery** — kill the owner, invalidate old sessions, reconnect through one replacement owner; exercise
    stale locks, PID reuse, missing process-journal entry, replay overflow and cursor from a previous instance.
12. **Settings** — app legacy/core handover preserves app settings and ChatGPT account across core →
    legacy → core; concurrent CLI edits remain isolated in the CLI scope. No cross-scope downgrade merge.
13. **All session consumers** — models, metrics, embeddings, Responses and context retries resolve core sessions;
    phase 4 also covers still-legacy TurboQuant/MLX and explicit FM capabilities, registration expiry and unload.
14. **Release/platform boundaries** — execute signed universal artifact on macOS arm64/x64, validate Windows
    running-binary update refusal and preserve required iOS/Android builds when desktop legacy is removed.
15. **Stage 4 review regressions** — race two flag changes against login and start/stop; fail the settings
    write after listener transfer, then fail the reverse transfer; lose the response to `/server/stop`.
    Never show a guessed running state or open a second listener. Kill the core while `:1337` serves,
    observe a new generation and the actual fallback port in Launch, then repeat after explicit stop,
    tray close and full exit. Restart the app while its previous registration remains live.
16. **CLI lease and cloud destination** — run long `serve`/login commands while attempting an upgrade;
    exercise idle 0.1 and active 0.2+ daemons. With `--data-folder=A` and
    `ATOMIC_CORE_DATA_FOLDER=B`, refuse app-folder aliases. Delay/fail each credentials/settings
    write and restart between writes while an HTTP receiver checks that a key never reaches the URL
    of a different provider configuration.

These are target scenarios, not claims of implemented coverage. Record evidence/grade before each phase exit.

## Stage 3 evidence (2026-09-16)

- `npm run verify` builds and drives the core binary on an isolated data folder. `test/e2e/owner.test.ts`
  covers 3b settings import/409/owner replacement, 3c local HTTPS manifest+archive via proxy,
  checksum/fallback/cancellation/SSE progress and revisioned optimal cache, and 3d embedding after
  a real child-process 501/reload. Windows adds a CUDA companion zip; shell-script backend tests
  are POSIX-only. The settings case caught an acknowledgement defect and now checks that the
  post-write revision stays `in_sync` across restart, then becomes stale after another edit.
- With the app-binary path supplied, `make test-core-live ATOMIC_CORE_BIN=/absolute/path/to/atomic-chat-app-core`
  in `../Atomic-Chat` drives the actual app supervisor and relay: startup without a call, crash
  recovery, three-restart ceiling, snapshot before SSE deltas and replacement generation.
- Existing extension tests exercise ownership routing and event translations with mocked Tauri IPC.
  They are not desktop end-to-end tests.

There is **no implemented desktop-UI runner** at `test/app-e2e/` and no `make test-app-e2e` target in
the app today. Do not treat `npm run test:app-e2e` (zero cases) as a passing gate. Before stage 4,
the still-missing acceptance tests must launch an app with an isolated data/config root and assert
actual UI state for load/session resolution, off→on→off and rollback, backend install/update/optimal
with progress/error/cancel, embedding/RAG, and snapshot recovery after an owner crash. A deterministic
desktop driver would need a separately approved test dependency or runner; AutoQA's model-driven
computer tests are not a deterministic CI substitute.

## Stage 4 isolation evidence (2026-09-17)

- The compiled-binary `test/e2e/scopes.test.ts` starts the dedicated app and CLI owners simultaneously,
  verifies separate PID/lock/model inventory/key/state, refuses the app path, and exercises idle-versus-active
  CLI daemon upgrade. Unit tests cover Windows/Linux/macOS path rules, nested symlinks and Windows case aliases.
- `make test-core-live` exercises the real app binary's crash recovery, full-exit shutdown/lock
  release and termination after an app registration disappears without a shutdown request. Focused
  live cases also verify old-version replacement and refusal to stop a PID with unknown identity;
  `core::server::ownership` covers publish-before-listen, failed-start rollback and an existing listener.
- These are process and protocol tests, not proof that hiding the real Tauri window keeps models running or
  that Codex/Claude Code/OpenCode and the ChatGPT account work in a launched UI. Those checks remain manual.
- Stage 4 review-fix adds unit coverage for lost stop replies and unknown listener status, CLI command
  heartbeat/upgrade protection, and a cloud key bound to the canonical provider configuration.
  The compiled-binary e2e suite and app supervisor live suite pass, but there is still no deterministic
  desktop-UI runner: Launch fallback-port display, real Tauri start/stop/flag races, tray behaviour,
  and live-cloud/agent flows remain unverified rather than being inferred from these lower layers.
