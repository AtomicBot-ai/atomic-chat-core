# Running the Tauri app against this core (app-e2e)

Goal: prove the app and the core see the same world at every migration phase (PLAN.md §5.1, "App-E2E").

## Prerequisites

- `../Atomic-Chat` checked out next to this repo, `make dev` run once there.
- This repo built: `npm run build && npm run build:bin`.
- Bun on PATH (source mode only).

## Modes

| Mode | How the app finds the core | Use |
| --- | --- | --- |
| Binary | `resources/bin/atomic-chat-core` (after `yarn download:core` in the app, phase 2+) | release-like runs |
| Source | `ATOMIC_CORE_CMD="bun run ../atomic-chat-core/src/cli/main.ts" yarn dev` in the app | launcher only; app appends `daemon` and arguments |

Flags in the app: `ATOMIC_CORE_RUNTIME=off|llamacpp-upstream|all`, `ATOMIC_CORE_SERVER=legacy|core`
(env overrides of `<data>/store.json` keys `atomic_core.runtime` / `atomic_core.server`).

## Scenarios (each maps to an exit criterion in PLAN.md §4)

1. **Data-folder parity** — `atomic-chat-core models list --json` equals what the app's extension `list()`
   returns for the same `<data>` (fixture dumped by the app-side script).
2. **argv parity** — same inputs produce equivalent backend argv after explicit dynamic-field normalization
   (PLAN.md §5.1); test the intentional CLI detach-on-Ctrl+C change separately.
3. **UI load → sessions** — load a model in the app UI; `GET /atomic/v1/sessions` matches what
   `model-factory.ts` resolved (port, api_key).
4. **auto-increase-ctx** — overflow the context from the proxy path and from the agent path; both recover.
5. **Backend install** — install/update/"find optimal" from the UI; progress and completion events reach the UI.
6. **Flag round-trip** — transfer `atomic_core.runtime` off → llamacpp-upstream → off with no active conflicting
   operation, unload, revision acknowledgment and settings preservation. Reject unsupported flag combinations.
7. **External clients** — Codex (`/responses`), Claude Code (`/messages`), OpenCode (`/chat/completions`) against `:1337`.
8. **Ownership before CLI distribution** — CLI → app and app → CLI; one owner, no duplicate model, no reaping
   a live owner's backend. Legacy conflicts fail before mutation. Standalone requires a separate data folder.
9. **Client exit** — close/force-quit the app while CLI uses a core-owned model; it stays available. Reopen
   the app and attach. Explicit shutdown detects other active clients; final shutdown leaves no orphan.
10. **Independent listeners** — stop/start or change public host/port while control, sessions and SSE remain
    reachable. A failed legacy/core public-server transfer restores the previous owner or reports stopped.
11. **Recovery** — kill the owner, invalidate old sessions, reconnect through one replacement owner; exercise
    stale locks, PID reuse, missing process-journal entry, replay overflow and cursor from a previous instance.
12. **Settings** — first core-load honors legacy settings; change through CLI with app closed, then reconnect;
    test planned downgrade, unacknowledged downgrade, independent edits and a same-field conflict on return.
13. **All session consumers** — models, metrics, embeddings, Responses and context retries resolve core sessions;
    phase 4 also covers still-legacy TurboQuant/MLX and explicit FM capabilities, registration expiry and unload.
14. **Release/platform boundaries** — execute signed universal artifact on macOS arm64/x64, validate Windows
    running-binary update refusal and preserve required iOS/Android builds when desktop legacy is removed.

These are target scenarios, not claims of implemented coverage. Record evidence/grade before each phase exit.

## Stage 3 evidence (2026-09-16)

- `npm run verify` builds and drives the core binary on an isolated data folder. `test/e2e/owner.test.ts`
  covers 3b settings import/409/owner replacement, 3c local HTTPS manifest+archive via proxy,
  checksum/fallback/cancellation/SSE progress and revisioned optimal cache, and 3d embedding after
  a real child-process 501/reload. Windows adds a CUDA companion zip; shell-script backend tests
  are POSIX-only. The settings case caught an acknowledgement defect and now checks that the
  post-write revision stays `in_sync` across restart, then becomes stale after another edit.
- With the binary path supplied, `make test-core-live ATOMIC_CORE_BIN=/absolute/path/to/core-binary`
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
