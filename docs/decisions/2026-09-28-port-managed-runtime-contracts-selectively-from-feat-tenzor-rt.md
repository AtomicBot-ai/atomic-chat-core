---
date: 2026-09-28
title: "Port managed-runtime contracts selectively from feat/tenzor-rt"
---

# 2026-09-28 — Port managed-runtime contracts selectively from feat/tenzor-rt

- **Context:** `origin/feat/tenzor-rt` @ `632b934` already had a working design for the managed
  (containerized) text-runtime wire contracts — the environment/operation state machine, the
  runtime-descriptor shape, the `MANAGED_*`/`MODEL_INCOMPATIBLE`/`GPU_BUSY` error codes, and
  `SessionInfo.pid` going nullable for a session that is a container rather than a host process. But
  that branch forked before several `main` features existed (backend-advisor, hardware, diffusion
  video, telemetry, `session:load-progress`'s own predecessors) and carries stale copies of them; and
  its descriptor shape predates `atomic-chat-conf`'s published schema, which has since gained
  `probe_image`, `model_families`, `minimum_driver_version` and per-quantization
  `excluded_compute_capabilities`, and dropped `entrypoint_digest`. Merging the branch wholesale would
  both regress `main` and ship a descriptor shape the real conf data no longer produces.
- **Decision:** Port only the managed-runtime deltas, by hand, file by file, comparing each one
  against `main` and taking just the lines the branch added — never `git merge`/`cherry-pick`
  `feat/tenzor-rt` as a whole (openspec change `add-tensorrt-llm-linux`, design D1, task 2.1). Where
  the branch's shape and the conf schema disagree, the conf schema wins:
  `atomic-chat-conf/runtimes/schema.json` (read at commit `c21e520`, the tip of conf's own
  `change/add-tensorrt-llm-linux` at the time of this port) is the source of truth for
  `RuntimeDescriptor`, not the branch's `src/contracts/environment.ts`. Concretely, this task:
  - Ported `src/contracts/environment.ts` with the descriptor reshaped to the schema: `image` and
    `probe_image` are now per-platform maps (`linux/amd64`, `linux/arm64`) rather than one platform
    literal; `recipes` carry only `recipe_id` + `distributions` (no per-recipe digest, no `executor`
    field — a distribution's own `id`/`version_id`/`arch` is what a host recipe matches against);
    `quantization` entries gained `excluded_compute_capabilities`; the descriptor gained
    `minimum_driver_version` and `model_families`; `entrypoint_digest`, `$schema`, `ArtifactLocation`
    and `ModelResolution` were dropped (design D12: model download moves to app/cli, core only
    checks compatibility from a submitted file list, never fetches bytes). Added `ModelCompatibility`
    — new, not on the branch — as the verdict type of the future
    `POST /atomic/v1/models/tensorrt-llm/check` (spec `tensorrt-llm-models`).
  - Ported the `errors.ts` delta (`MANAGED_*` codes, reusing `MODEL_INCOMPATIBLE` from the diffusion
    codes rather than redeclaring it), the `events.ts` delta (`environment:changed`,
    `environment:operation`), and `session.ts`'s delta (`SessionInfo.pid: number | null`,
    `execution`, `generation`). `session:load-progress` does not exist anywhere on the branch — it is
    new here, added from the task brief's own description of design D8/task 2.12's four lifecycle
    stages (`stopping-previous`/`starting-container`/`initializing-engine`/`ready`), since spec
    `tensorrt-llm-runtime` names its payload (provider, model, generation, stage, elapsed time)
    before any branch commit defines it.
  - Bumped `CONTROL_PROTOCOL_VERSION` 1 → 2, because `SessionInfo.pid` becoming nullable is a
    breaking wire change: an app built against protocol 1 cannot deserialize a container session and
    would silently drop it rather than fail loudly.
  - Wrote a new `src/runtime/environment/descriptor.ts` shape validator (not a line-for-line port of
    the branch's own `descriptor.ts`, which validates the old, now-wrong shape) that accepts
    `atomic-chat-conf/runtimes/tensorrt-llm.json` verbatim, copied into this repo as
    `test/fixtures/runtimes/tensorrt-llm.json` at conf commit `c21e520`. It intentionally does not
    check `adapter_id` against a compiled adapter registry (that registry does not exist until task
    2.12's `ManagedTextAdapter`) or fetch/cache the descriptor over HTTPS (task 2.2). The rest of
    `src/runtime/environment/*` from the branch (state machine, store, recovery, service,
    canonical-json, host-exec, inventory, linux/windows probes) is left for task 2.2, which was
    already the plan (see the task's own text).
  - Added `hostPid(session)` to `src/runtime/shared/process.ts`, ported verbatim from the branch,
    and converted every place in `src/` that killed, journalled or probed a `SessionInfo`'s pid
    (`src/runtime/llamacpp/runtime.ts`, `src/runtime/shared/sidecar.ts`, and the test files that
    exercised them directly, plus `src/core/sessions.test.ts`) to go through it instead of reading
    `.pid` straight off the session. This was not optional: once `pid` is `number | null`, every
    direct read is a type error at the call site, so the conversion is what makes the branch's
    nullability change typecheck at all, not merely a style preference.
- **Consequences:** `src/contracts/` now carries a working, tested set of managed-runtime types that
  tasks 2.2 onward build the actual state machine, descriptor cache, Docker executor and
  `tensorrt-llm` provider on top of — none of it wired to a route or an event producer yet. A caller
  that kills, journals or probes a session's process must call `hostPid` and handle
  `MANAGED_IDENTITY_MISMATCH`; a raw `.pid` read is a type error for exactly that reason, which is
  the intended guard rail once containers exist. Because the branch's own descriptor validator was
  not reused, task 2.2 should treat the new `descriptor.ts` as the one to extend (with adapter-catalog
  checking, HTTPS fetch and disk caching) rather than reconcile two competing parsers.
  `test/fixtures/runtimes/tensorrt-llm.json` is a point-in-time copy pinned to conf commit `c21e520`;
  it will drift from conf `main` as that repo's own task 1.x work continues; whoever next touches the
  descriptor parser should re-diff the fixture against conf and note the new source commit here or in
  a successor ADR.
- **Owner:** team.
- **Links:** openspec change `add-tensorrt-llm-linux` (`atomic-chat-spec`), design D1/D7/D9/D12/D16/D17;
  spec `tensorrt-llm-models`, `tensorrt-llm-runtime`; source port commit `origin/feat/tenzor-rt` @
  `632b934`; conf fixture source commit `c21e520` (`atomic-chat-conf` branch
  `change/add-tensorrt-llm-linux`); `src/contracts/environment.ts`, `src/contracts/errors.ts`,
  `src/contracts/events.ts`, `src/contracts/session.ts`, `src/contracts/control-api.ts`,
  `src/runtime/environment/descriptor.ts`, `src/runtime/shared/process.ts`.
