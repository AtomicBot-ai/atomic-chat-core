---
date: 2026-09-28
title: "Managed runtime layout: the shared per-user root only, no per-scope artifact store"
---

# 2026-09-28 — Managed runtime layout: the shared per-user root only, no per-scope artifact store

- **Context:** `origin/feat/tenzor-rt` @ `632b934` (ADR
  `2026-09-22-managed-runtimes-split-per-user-environment-from-per-scope-data`, ported into that
  branch's `src/config/paths.ts`) split the managed-runtime layout in two: a root shared by the app
  and CLI scopes for the container environment itself (`<dataDir>/atomic-managed-runtimes/`, because
  the environment belongs to the machine's user account and must survive a data-folder move), and a
  per-scope root under `<data>/atomic-core/managed-runtimes/` for what each scope owns alone —
  running containers (`executions/`, `heartbeats/`) and downloaded model bytes (`artifacts/`,
  `caches/<engine_id>/<descriptor_id>/<artifact_id>/`). Task 2.2 of openspec change
  `add-tensorrt-llm-linux` ports `src/runtime/environment/{state,store,recovery,service,...}` onto
  `main`, and `store.ts` needs exactly one piece of that layout: the shared root, for
  `environment.json`/`environment.lock`/`installations/`/`operations/`.

  The per-scope half splits into two kinds of thing, for two different reasons neither of which this
  task's scope covers:
  - `artifacts/` and `caches/<engine_id>/<descriptor_id>/<artifact_id>/` held downloaded **model
    bytes** and their per-engine derived forms. Design D12 (task 2.1's port of
    `src/contracts/environment.ts`) already dropped `ArtifactLocation`, `ModelResolution` and the
    Hugging Face token from the wire contracts: core no longer downloads model weights or resolves
    where their bytes live, permanently — that is the app's and the CLI's job now. This half of the
    layout is not merely unbuilt; nothing in the current design has anywhere for it to write.
  - `executions/` and `heartbeats/` — one running container's authority record and the watchdog file
    its heartbeat touches — are **not** dropped by D12 at all; a managed engine that is actually
    running still needs exactly this kind of per-scope bookkeeping (and, once containers exist,
    their logs and the sessions running inside them need somewhere per-scope too). They are simply
    not built yet: the Docker executor (task 2.8), the setup operation that would create the first
    execution record (task 2.6), and the managed session gateway (task 2.11, landed after this ADR
    was first written) are what will need a per-scope path for them, each adding it when it does.

  Porting either half now would add disk paths this task has no writer for, in the first case because
  the design deliberately has none, in the second because the writer is a later task's, not this
  one's.
- **Decision:** Port only the shared half. `src/config/paths.ts` gains `MANAGED_ROOT_ENV`
  (`ATOMIC_CORE_MANAGED_ROOT`), `MANAGED_SHARED_DIR` (`atomic-managed-runtimes`), `encodeManagedId` /
  `decodeManagedId` (one id, one directory name, through percent-encoding — unchanged from the
  branch, since operation and installation ids need it exactly as much as an artifact id would),
  `managedSharedPaths(root)` and `managedSharedRoot(env)`. `DataLayout` gains no `managed` field:
  nothing in this port reads a per-scope managed path, so adding an empty promise of one would be a
  seam with no caller. `docs/contracts.md`'s data-path table and paragraph describe only the shared
  root this task actually writes to.
- **Consequences:** The per-scope half — `ManagedScopePaths`, `managedScopePaths()`,
  `executionFile`/`heartbeatFile`/`artifactDir`/`cacheDir`, and `managedHostPath` (which throws on a
  guest `ArtifactLocation`, a type this port does not have) — is not on `main` yet. `artifactDir`/
  `cacheDir` and `managedHostPath` stay unbuilt on purpose, per D12, unless a later ADR reopens model
  artifacts for core to manage. `executionFile`/`heartbeatFile` — and whatever container logs and
  in-container session bookkeeping the managed session gateway turns out to need — are simply
  deferred: the Docker executor (task 2.8) adds execution/heartbeat records when it starts a real
  container, and tasks 2.10/2.12 add whatever per-scope path their own piece needs, each following
  this same shared-vs-scope split so a data-folder move still leaves the environment alone. Nothing
  else in `src/runtime/environment/*` from the branch touched a per-scope path (checked directly:
  only `store.ts` and `wiring.ts` import from `src/config/`), so this narrowing costs the rest of the
  port nothing.
- **Owner:** team.
- **Links:** openspec change `add-tensorrt-llm-linux` (`atomic-chat-spec`), task 2.2; branch ADR
  `2026-09-22-managed-runtimes-split-per-user-environment-from-per-scope-data` (source of the design
  this narrows); `src/config/paths.ts`, `src/config/paths.test.ts`,
  `src/runtime/environment/store.ts`, `src/runtime/environment/wiring.ts`, `docs/contracts.md`.
