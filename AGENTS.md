# AGENTS.md — atomic-chat-core

Operating instructions for AI agents and humans working in this repository.
Everything here applies to every task. Anything that applies only sometimes lives behind a link.

| Need                                      | Go to                                                          |
| ----------------------------------------- | -------------------------------------------------------------- |
| The whole plan: context, phases, port-spec | [`PLAN.md`](PLAN.md)                                           |
| Why something is built this way           | [`docs/decisions/INDEX.md`](docs/decisions/INDEX.md)           |
| Wire contracts shared with the app        | `src/contracts/`, `test/contract/`, [`docs/contracts.md`](docs/contracts.md) |
| Critical-flow test evidence               | [`docs/testing-critical-flows.md`](docs/testing-critical-flows.md) |
| Running the Tauri app against this core   | [`docs/app-e2e.md`](docs/app-e2e.md)                           |

---

## 1. What this is

The TypeScript inference core of **Atomic Chat**: local inference (llama.cpp upstream + turboquant fork,
MLX, Apple Foundation Models), backend and model management, cloud providers, the model→provider router
and the OpenAI-compatible server on `http://localhost:1337/v1`.

This extraction targets desktop only; required iOS/Android Rust paths remain in the app.

Consumers:

- **CLI** — this repo compiled into one binary (`bun build --compile`).
- **Tauri app** (`../Atomic-Chat`) — attaches to a standalone local owner over HTTP `/atomic/v1` + SSE.
- **Any OpenAI-compatible client** (Codex, Claude Code, OpenCode, curl) — over `/v1`.
- **TypeScript programs** — `import 'atomic-chat-core'`.

The core is extracted from the app in phases (see `PLAN.md` §4). Preserve on-disk and wire compatibility
using explicit comparators and dynamic-field normalization (`PLAN.md` §5.1). Do not freeze incidental
serialization details. Intentional behavior changes require an ADR and dedicated tests.

Control binds to a permanent loopback listener; the public inference listener starts/stops independently.
App/CLI exit detaches without stopping the owner. Use snapshot + SSE with instance identity to rebuild
state after reconnect; stdout carries only the bootstrap ready line. See `PLAN.md` §3.4–3.6.

---

## 2. Repository map

| Path                                | What lives there                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `src/contracts/`                    | Types + string constants only. **Browser-safe.** Error codes, `SessionInfo`, `model.yml`, events, control API.       |
| `src/client/`                       | **Browser-safe.** Injected fetch or Tauri Rust relay transport for `/atomic/v1`; extension adapter uses the relay. |
| `src/config/`                       | Data-folder resolution (same rules as the app), on-disk layout (`DataLayout`, `ProviderPaths`).                      |
| `src/settings/`                     | `<data>/atomic-core/settings.json`, JSON schemas of provider settings, legacy `localStorage` import.                  |
| `src/credentials/`                  | `<data>/atomic-core/credentials.json` (0600), ChatGPT OAuth (PKCE, callback :1455).                                  |
| `src/events/`                       | Typed `EventEmitter`; the catalog is in `src/contracts/events.ts`.                                                    |
| `src/hardware/`                     | CPU/GPU/VRAM probes via system tools; override endpoint for NVML/Vulkan facts injected by the app.                    |
| `src/downloads/`                    | Resumable downloads (`.tmp` + `.url`), sha256, disk-error tags, `.tar.gz`/`.zip` extraction.                         |
| `src/backend/`                      | llama.cpp backend packs: `catalog/` (manifest, archive names, id migration), `select/` (hardware tiers), `installed/` + `install/` (packs on disk, install/update), `optimal/` (optimal-backend cache), `turboquant.ts`. |
| `src/models/`                       | `model.yml`, model registry, import (URL/HF/local/sharded), GGUF metadata + KV-cache estimate.                        |
| `src/speculative/`                  | MTP / DFlash / EAGLE-3 draft registries, transcription model, chat-template overrides.                                |
| `src/runtime/`                      | `shared/` (spawn / readiness / kill, ports, env, sidecar table), `llamacpp/` (provider-parameterised), `mlx/`, `foundation-models/`. |
| `src/core/`                         | `AtomicCore` facade (`atomic-core.ts`), service wiring (`create.ts`), local sessions, public-server lifecycle.         |
| `src/cloud/` `src/router/` `src/server/` | Providers + key injection; model→target resolution; HTTP server (`/v1/*` public in `server/public/`, `/atomic/v1/*` control in `server/control/`, one file per route family). |
| `src/remote-access/`                | Reaching the public listener from outside: the Cloudflare quick tunnel (`manager.ts` state machine, `process.ts`, `probe.ts`, `journal.ts`, pure `cloudflared-{args,output}.ts`, `status.ts`) and the LAN addresses (`lan.ts`, `lan-probe.ts`). The Host gate that lets those callers in is `server/public/dynamic-hosts.ts`. |
| `src/diffusion/`                    | Image generation on stable-diffusion.cpp, a module of its own (not a `LocalRuntime`). Pure so far: `args.ts` (argv, `img_gen` body), `progress.ts` + `tracker.ts` (reading `sd-server`'s output), `parse.ts` + `validate.ts` (request bodies), `workflow.ts`, `errors.ts`. Wire types live in `src/contracts/diffusion.ts`. |
| `src/lock/`                         | One owner per canonical data folder; PID/start identity, attach, child-process journal and legacy-resource guards. |
| `src/cli/`                          | `main.ts` is the binary entry; one file per subcommand in `commands/`.                                                |
| `test/`                             | `contract/`, `e2e/`, `app-e2e/`, `runtime-compat/`, `live/`, `fixtures/`, `helpers/`. Unit tests live next to code.  |
| `scripts/`                          | CI gates: `check-runtime-agnostic.mjs`, `check-test-quality.mjs`, `check-coverage-floor.mjs`; `build-binaries.mjs`; `import-app-fixtures.mjs`. |
| `docs/decisions/`                   | ADR log, one file per decision, append-only.                                                                          |

---

## 3. Code organisation rules

1. **One module = one folder with `index.ts` as the only public entry.** Cross-module imports go through
   `index.ts` (lint-enforced). If you need something that is not exported, export it deliberately.
2. **Policy is pure, I/O is separate.** `load-plan.ts`, `args.ts`, `select.ts`, `resolve.ts` take data and
   return data. `fs`, `child_process`, `fetch` live only in `runtime.ts`, `process.ts`, `store.ts`,
   `downloader.ts`. Pure code is tested with tables, I/O code with fake processes and fixture servers.
3. **Inject the environment.** `fetch`, `env`, `platform`, `exec`, `now` come through constructors or
   options. Never read `process.platform` inside policy code — Windows branches must be testable on macOS.
4. **Errors** are `AtomicCoreError { code, message, details? }`. Codes live in `src/contracts/errors.ts`
   and match the app's Rust codes verbatim. Disk failures carry the `[disk_*]` tag in the message.
5. **Events** go through `src/contracts/events.ts`. A new event = type + catalog entry here + relay
   mapping in the app repo, in the same pair of PRs.
6. **Runtime-agnostic.** Only `node:*` builtins and global `fetch`. No `Bun.*`, no `bun:*`, no native
   addons, no `worker_threads`, no `import.meta.url`-relative file loading (breaks under `--compile`).
   Embed JSON with `import … with { type: 'json' }`. `npm run lint` fails otherwise.
7. **Naming.** New identifiers are `atomic-*`, never `jan*`. Files `kebab-case.ts`, classes `PascalCase`,
   functions `camelCase`. Data paths: only those listed in `docs/contracts.md`; never invent a new one.
8. **Dependencies.** `yaml`, `tar`, `yauzl`, `ai`, `@ai-sdk/openai-compatible`. Adding one needs an
   explicit "ok" from the owner and an ADR.
9. **Do only what was asked.** No drive-by refactors or cleanups; propose them instead.
10. **Never commit unless explicitly asked.**
11. **Record non-trivial decisions** as a new file in `docs/decisions/` (template `_TEMPLATE.md`), in the
    same session, and add one line to `INDEX.md`.
12. **Everything written in the repo is English** — code, comments, commit messages, docs, ADRs, `PLAN.md`
    and its journal, scripts and their output. The only exception is non-English test data that a test
    exists to exercise (Unicode paths, UTF-8 boundaries, fixtures imported from the app).

---

## 4. Commands

```bash
bun install                          # deps (bun.lock is committed)
npm run typecheck                    # tsc; types:["node"] — any Bun.* is a type error
npm run lint                         # eslint + runtime-agnostic gate + test-quality gate
npm run test                         # unit + contract on Node (< 30 s)
npm run build && npm run build:bin   # dist/ + dist/bin/atomic-chat-core-<triple>
npm run test:e2e                     # drives the compiled binary
npm run test:runtime-compat          # spawn/signals/ports/SSE under Node and under the Bun binary
npm run test:app-e2e                 # needs ../Atomic-Chat checkout + built app — docs/app-e2e.md
ATOMIC_LIVE=1 npm run test:live      # real backends / cloud; needs env, see PLAN.md §5
npm run verify                       # everything above except app-e2e and live — run before finishing
```

Bun is the packager and the e2e runtime. Node 22 is the development runtime. Code never knows which.

---

## 5. Testing — non-negotiable

- **Every exported function has a unit test next to it** (`foo.ts` ↔ `foo.test.ts`), table-driven for
  policy code. `scripts/check-test-quality.mjs` fails the build otherwise (allowlist in
  `test/test-quality-allowlist.json`, entries need a reason).
- **Every wire contract with the app has a fixture** in `test/fixtures/` emitted from the app's Rust
  tests (`cargo test -- --ignored dump_fixtures` in `../Atomic-Chat`) and replayed in `test/contract/`.
  Pin each fixture's source commit and comparator; a semantic contract change requires an ADR.
- **Every user-visible flow has an e2e test against the compiled binary** (`test/e2e/`, using
  `test/helpers/fake-llama-server.ts`) **and an app-e2e scenario** proving the Tauri app sees the same
  thing (`test/app-e2e/`, `docs/app-e2e.md`).
- **Coverage floors** (`test/coverage-floor.json`) only go up. Windows CI is mandatory for anything
  touching `src/runtime/`.
- **Grade every critical flow** in `docs/testing-critical-flows.md` (Strong / Partial / Smoke / Missing).
  A PR may not lower a grade. Line coverage alone never raises one.
- **Verify before you finish:** `npm run verify`. For `src/runtime/` changes also run `npm run test:e2e`
  on your OS and say which OS in the summary.

---

## 6. Keeping this file small

Target ≤ 200 lines, never > 300. No decision log here — one ADR per file under `docs/decisions/`.
No duplication with `PLAN.md` or `docs/` — link instead. When they disagree, the linked doc wins and
this file gets fixed.
