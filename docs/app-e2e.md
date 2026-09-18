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

The app has no ownership flags any more: since stage 6 the core owns every desktop runtime and the
public server unconditionally, and an old `atomic_core` object in the app's `settings.json` is read and
ignored. Scenarios 6 and 12 below describe the flag round-trip as it was planned for stages 3–5.

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

That was true on 2026-09-16. A desktop-UI runner exists since 2026-09-18 — see the last section.

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


## Desktop UI runner (2026-09-18)

The app has a deterministic desktop-UI runner: `make build-app-e2e` and `make test-app-e2e` in
`../Atomic-Chat` (macOS arm64, outside `make verify`). It launches the real app, built with a WebDriver
server behind a cargo feature, on a temporary profile with `ATOMIC_CORE_CMD` pointing at a binary from
this repo's `dist/bin`, and drives the window with the plain `webdriverio` client. The backend is this
repo's `test/helpers/fake-backend-pack.ts`, imported from the sibling checkout and installed as
`b99999/macos-arm64`: the app's upstream extension silently downloads any backend newer than the
configured one, and the fake has to be the newest. Teardown uses `reapJournalledChildren` from
`test/helpers/compiled-core.ts`. The design and its isolation rules are recorded in the app's ADR
`docs/decisions/2026-09-18-drive-the-desktop-ui-through-an-embedded-webdriver-on-an-isolated-profile.md`.

What it proves of the scenarios above:

- **3. UI load → sessions** — a model picked in the UI is loaded through the core; the session the
  webview resolves (`resolve_local_session`: pid, port, api_key) equals the entry in
  `GET /atomic/v1/sessions`; the journalled child is the fixture backend; the streamed reply is rendered
  and persisted, and the thread rehydrates after a full restart of the app and the core.
- A backend that exits while loading reaches the conversation as `[LLAMA_CPP_PROCESS_ERROR]` with the
  process's stderr, and leaves no session in the core and no process behind.
- **10. Independent listeners**, in part — the public API is closed until started in the UI, refuses a
  request without the key, lists the app's model and streams a completion to an outside HTTP client
  from a model the core loads on demand, and closes again when stopped. Changing host/port while
  control and SSE stay reachable is not covered.
- **11. Recovery**, in part — a SIGKILLed backend disappears from `/sessions`, the UI reports the crash
  and the app reloads the model by itself; a SIGKILLed owner is replaced by a new ready instance from the
  app's supervisor, its orphaned backend is reaped rather than adopted, and the next message loads the
  model under the new owner. Stale locks, PID reuse, replay overflow and the restart ceiling are not.
- Switching the local model in the UI leaves exactly one session and one backend process.
- **12. Settings**, UI → core direction — a provider setting (`fit`) switched in the app's UI reaches
  `atomic-core/settings.json` and the argv of the next backend, both sides still agree after a full restart,
  and switching it back raises the revision. Conflicts, downgrade and the CLI scope are not covered.
- **Cloud through the core** — a custom OpenAI-compatible provider created in the app's UI is mirrored to
  `GET /cloud/providers` without its key; a chat in the app reaches it through the public server, which that
  chat starts; an outside client of the public server naming the cloud model gets the reply while the provider
  receives its own key, which that client never had.
- **7. External clients**, configuration only — "Run" for Codex on the app's Integrations page starts the
  public server and writes `~/.codex/config.toml` (in a stand-in home) naming it and the running model,
  keeping the user's own settings. No real agent is run against `:1337`.
- A model stopped by hand from the provider's settings is unloaded in the core, stays down although it is
  still selected, and comes back with the next message.
- Relocating the app's data folder from Settings: the app restarts itself on the new folder and the thread,
  the model and the backend are found there. The app stops its core before copying the folder and leaves the core's
  runtime state behind (`instance.lock`, `control-token`, `processes.json`, `model-claims/`), so the core
  is serving the new folder within seconds. Until 2026-09-18 the lock was copied with a live pid — which
  this core never judges stale — and the new folder went unserved for about 40 s, until the previous core's
  registration of the vanished app lapsed.
- A model installed from the Hub (catalog, picks and file served by a local fixture) downloads through the
  app's own downloader, not the core's, and is then served by the core under the downloaded id. A
  cancelled download registers nothing.
- A backend installed from a release archive in the app's settings is what the core starts on the model's
  next load; a model already running keeps its backend. The core's download-and-verify install is reached from
  the UI as well: a release published on the test machine behind a loopback CONNECT proxy (the shape of
  `test/helpers/backend-install-e2e.ts`), found through the app's proxy setting, installed by
  `POST /backends/llamacpp-upstream/install` with that proxy, and started on the next load.
- **4d, the request inspector:** an outside client's streamed completion through the public server shows up
  on the app's open API page without a reload — `api:request` started/finished relayed to the webview — with
  its prompt and reply previews; a request without the key is counted as an error.
- **5, a second local provider:** with TurboQuant turned on in the app, one model is run under `llamacpp`
  and then under `llamacpp-upstream`, each from its own backend directory; `/sessions` names the provider
  and the previous process is gone. Scripted backends on both sides.
- **3d, embeddings:** a document attached in the app is embedded through `POST /models/…/embed` by an
  embedding session the core starts for it (`--embedding --pooling mean`), and a `retrieve` tool call made by
  the chat model embeds the query the same way and brings the document's words back. Scripted backends; the
  chat model's tool turn comes from `toolCall` in `test/helpers/fake-llama-server.ts`.
- **Tools over a core session:** an MCP tool called by the chat model, with and without the user's approval;
  and the app's agent loop, which borrows the chat model's session and drives the backend's raw `/completion`
  (`completionSteps` in `test/helpers/fake-llama-server.ts` scripts the model's steps).
- **4e, recovery of the public server:** the core is killed under a running public server; the app has the
  next generation listen on the same port with the same key and loads the served model again, and an outside
  client's streamed completion is answered.
- An opt-in scenario (`make test-app-e2e-live`) runs the same chat against a real `llama-server` b10809 and
  Qwen3-0.6B: the core's argv starts it, readiness is recognised, a reply comes back, and a forced shutdown
  stops the child. With that binary `runtime_device` comes back empty — it prints no log lines by default,
  so there is nothing to parse a device from.
- **4. auto-increase-ctx**, chat path only — with the provider's `fit` off the core is given an explicit
  `--ctx-size`; a backend answering `exceed_context_size_error` below a threshold makes the app grow the
  window past it, the core replaces the process, and the reply arrives. The proxy and agent paths are not
  covered.

Everything else in the list — auto-increase-ctx, backend install/update with progress and cancel,
real external agents (Codex, Claude Code, OpenCode), tray behaviour — is still unverified at the UI
level. With `fit` on, which is how the app ships, there is no `--ctx-size` and no ladder: the app tells
the user the context is fitted to the device — and then, a defect in the app's thread route recorded
there as an expected failure, leaves the thread stuck in "Growing the Mind..." with sending disabled. `test/app-e2e/` in this repo stays empty: the runner lives with the app it launches.
