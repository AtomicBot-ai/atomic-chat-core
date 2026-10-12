---
date: 2026-10-08
title: "The core applies engine updates on a client's command and owns llama.cpp's version_backend"
---

# 2026-10-08 — The core applies engine updates on a client's command and owns llama.cpp's version_backend

- **Context:** Versions, updates and removals of engines ran three unrelated ways — llama.cpp packs
  (`/backends/:p/*`), sd.cpp and MLX builds (`/engine-builds/:e/*`), the managed engines (`/environments`) — with no
  answer to "what is installed and what is newer" across them, and none at all for a new managed release. A
  llama.cpp update was applied by three copies of code in the desktop's extensions: install, write `version_backend`
  in `localStorage`, delete old packs with a Rust command (on Windows before the unload, over a running
  `llama-server.exe`), unload; `atc` had no such path. ADR 2026-09-27 had the core advise and never write
  `version_backend`.
- **Decision:** One layer, `src/engines/`, over the three systems without merging them (change
  `unify-engine-lifecycle`): `POST /engines/versions`, `POST /engines/:e/update`,
  `DELETE /engines/:e/builds/:v/:variant`, `POST /engines/:e/builds/:v/:variant/activate`, and `engine:changed` from
  every path that changes a build. The client still chooses the moment; the core applies.
  - **llama.cpp:** the core installs, then in the load queue's turn writes `version_backend` (clients mirror it on
    `settings:changed`), and unloads the provider's sessions through the facade. Activation is the same without the
    install. **No update deletes a build, on any engine** (sd.cpp and MLX installs and the start neither): the old
    ones stay listed, inactive, until the user removes them; `retired` and `kept_in_use` stay in the answers, always
    empty (decided at the change's acceptance, 2026-10-09, replacing its design D5). **This replaces "the core does not
    write `version_backend`" of ADR 2026-09-27**; the rest of that record stands.
  - **The installer's packs:** a pack named by `<resources-dir>/../llamacpp-backend-upstream/{version.txt,
    backend.txt}` (and `…/llamacpp-backend/…` for TurboQuant) is `bundled`: never removed — the app
    copies it back at every start. `atc` passes no `--resources-dir` and has none.
  - **Busy packs:** a pack a session, the decision model or the embedding model runs from is never removed
    (`BACKEND_IN_USE`), on `/engines` and on `DELETE /backends` alike; removal waits for a load in flight. One
    update, activation or removal of a provider at a time (`ENGINE_INSTALL_IN_PROGRESS`).
  - **Managed engines:** a newer `descriptor_id` (ordered by `<engine_id>-<version>-r<n>`) is offered as a reinstall.
    The update is a durable `remove` with the models kept, approved by the call itself, whose record carries the
    `setup` that follows; once it is `removed`, the core begins that setup under `<request_id>:setup` — at the next
    start too, exactly once by that id — and the setup asks the user for consent like any other. A failed or
    cancelled removal begins nothing.
- **Consequences:** The desktop takes offers only from `/engines/versions` and applies only through the core
  (app tasks of the change); `atc` gets the same commands as soon as it embeds this core. `DELETE /backends` answers
  two new refusals. Between the two halves of a managed reinstall the engine is not installed; a setup that fails
  leaves the user with their models and no engine, and the ordinary install continues from the current descriptor.
  The bundled-pack location is an implicit contract with the app's Tauri resources, checked by the app's e2e.
  Rulings of the implementation: `atomic-chat-spec/openspec/changes/unify-engine-lifecycle/rulings/core.md`.
- **Owner:** team.
- **Links:** `src/engines/`, `src/server/control/routes/engines.ts`, `src/contracts/engines.ts`,
  `src/backend/install/service.ts`, `src/backend/installed/bundled.ts`, `src/runtime/llamacpp/runtime.ts`
  (`exclusive`, `buildDirsInUse`), `src/runtime/environment/{service,store,wiring}.ts`, `test/e2e/engines.test.ts`.

<!--
Supersedes: 2026-09-27-the-core-advises-on-backends-the-app-decides.md (only the "does not write version_backend" clause)
-->
