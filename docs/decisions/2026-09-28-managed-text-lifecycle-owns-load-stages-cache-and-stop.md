---
date: 2026-09-28
title: "The managed-text lifecycle owns load stages, fast failure, the engine cache and confirmed stop; adapters own everything engine-specific"
---

# 2026-09-28 — The managed-text lifecycle owns load stages, fast failure, the engine cache and confirmed stop; adapters own everything engine-specific

- **Context:** Task 2.12 of openspec change `add-tensorrt-llm-linux` needs one load path for
  containerized text engines (spec `tensorrt-llm-runtime`: "Этапы и таймаут загрузки", "Кэш движка",
  "Watchdog", "Логи контейнера", "Выгрузка ждёт подтверждённой остановки"; design D8, D11) that the
  TensorRT-LLM adapter (2.13) and provider (2.14) plug into, with no branch on `engine_id`. Several
  choices were left open by the spec.
- **Decision:**
  - `ManagedTextAdapter` (`src/runtime/managed-text/adapter.ts`) carries everything engine-specific:
    settings validation, argv + container port, a readiness path and 2xx status, log stage markers,
    the size-based timeout, exit classification and capabilities. A registry keyed by `adapter_id`
    answers `MANAGED_ADAPTER_UNAVAILABLE` for an unknown id or a different contract version.
  - Stage markers refine *when* `initializing-engine` starts: with markers a started container stays
    in `starting-container` until one appears in its log; with none it moves on at `docker start`.
    Progress is re-emitted on every poll (1 s) with the elapsed time since the load began.
  - The readiness timeout runs from `docker start`; a provider setting replaces the adapter's value.
  - Fast failure is `docker inspect` on every poll: an exited (or vanished) container fails the load
    at once, classified by the adapter from the log tail — `out-of-memory` → `OUT_OF_MEMORY`,
    `unsupported-model` → `MODEL_INCOMPATIBLE`, `other` → `MODEL_LOAD_FAILED`; the error's `details`
    is the tail with Docker's `--timestamps` prefixes removed. A failed `inspect` is not read as an exit.
  - The readiness probe never follows a redirect (`redirect: 'manual'`); a redirect is "not ready".
  - The engine cache is `caches/<descriptor_id>/<model>` under the scope's managed root, created on
    load, never removed by unload, and removable by model and/or descriptor — refused with
    `MANAGED_RESOURCE_IN_USE` while a container of this core mounts it.
  - The last attempt's log tail (failure, cancel or crash after ready) is kept in memory per model and
    cleared when that model's next load starts; it does not survive a core restart.
  - Every end — unload, cancel, failure, crash — closes the gateway and stops the heartbeat before
    `docker stop`. Only a Docker-confirmed stop is followed by `rm` and the journal record's removal.
    An unconfirmed stop keeps the model as `stop-unconfirmed` in `reservations()` (for GPU residency,
    task 2.15), answers `MANAGED_STOP_UNCONFIRMED`, and blocks a new load of that model until an
    unload retries the stop. The heartbeat stops even then, so the watchdog ends an engine Docker lost
    track of within its stale limit.
  - A ready container is checked every 5 s; an exit ends the session with `session:died` (`pid: null`).
  - Under SELinux, `selinuxDataRoot` is the scope's data folder, not `<data>/atomic-core/managed-runtimes`:
    a model's directory lives under `<data>/<provider>/models/`, and `:z` is only ever applied to the
    four mounted sources, never to the root itself.
  - The docker CLI is resolved once at startup from `/usr/bin`, `/usr/local/bin`, `/bin` — never
    `PATH` — and `core/create.ts` builds the executor and reconciles the execution journal on Linux
    before the endpoint is published (`runtime/container/wiring.ts`).
- **Consequences:** a second engine is a second adapter. Polling costs one `docker inspect` per second
  per loading model (plus `docker logs` while markers are pending) and one per 5 s per loaded model.
  Logs of a failed attempt are gone after a restart; the `/logs` route (2.14) then has
  nothing to return. The poll interval, monitor interval and stop timeout are placeholders for live test 2.19.
- **Owner:** `team`.
- **Links:** `src/runtime/managed-text/{adapter,lifecycle,load-policy,readiness,engine-cache}.ts`,
  `src/runtime/container/{docker-binary,wiring}.ts`, `src/core/create.ts`, `docs/contracts.md`.
