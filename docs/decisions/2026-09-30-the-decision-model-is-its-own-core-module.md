---
date: 2026-09-30
title: "The decision model is its own core module, outside the sessions registry"
---

# 2026-09-30 — The decision model is its own core module, outside the sessions registry

- **Context:** The TurboQuant fork gains a new process role in release 1.7.0: `llama-server --decision -m
  <gguf>` serves a *decision model*, a small model that answers calibrated probabilities over fixed options in
  one forward pass, with no generation (`DECISION.md` in atomic-llama-cpp-turboquant, API version 1:
  `POST /v1/systemone`, `POST /v1/router/score`, `/health`, `/v1/models` capabilities, `/props.decision`, an
  error envelope with `reason` codes). The first one is the model router: before the chat model runs, it scores
  each executor's chance to meet the success criterion from a text card of measured results, and the routing
  policy (thresholds, prices, fallback) belongs to the core. Two things made the obvious homes wrong. Every
  GGUF the core ran was a chat or embedding session, and a model switch (`switchToModel`) and the chat
  auto-unload stop every other local session, so a router registered there would vanish exactly when it is
  needed. And the chat argument builder turns a GGUF without a chat head into `--embedding --pooling mean`;
  adding `laya` to `NON_TEXT_GGUF_ARCHITECTURES` would have done that to the Laya encoder, and leaving it out
  meant it would start as a chat model.
- **Decision:** `src/decision/` is a module of its own, built like image generation
  (2026-09-17-image-generation-is-its-own-module-not-a-local-runtime): one service, at most one process,
  never in `runtimes`, `/sessions`, the snapshot, `/v1/models` or the router. From the runtimes it borrows only
  process mechanics (`spawnManaged`, `randomFreePort`, `buildProcessEnv`, the backend-output sink) and the
  process journal, where its record carries `provider: 'decision'`.
  - *Launch:* its own pure argv builder, `--decision -m <gguf> [--decision-spec <file>] [-a <id>] --device none
    -t <n> --host 127.0.0.1 --port <free> --no-webui [--decision-allow-uncalibrated]`, the key in
    `LLAMA_API_KEY` (a random one per start, never in argv). `LLAMA_ARG_DECISION_*` is removed from the inherited
    environment, since the engine reads its `--decision-*` flags from those variables too (a stray `…_DEBUG`
    would log requests and return raw logits). `-t` is always passed: the setting, or the physical cores capped
    at 8, halved on Apple silicon (whose efficiency cores count as physical) until the hardware facts carry a
    performance-core count. Intel hybrid parts (Alder Lake and later) are not recognised, because
    `SystemInfo.cpu` has no core types: they get the full physical count, capped at 8, and some threads may run
    on E-cores. The engine's precedence was checked (`server-decision.cpp`, `engine-laya.cpp`): the laya engine
    runs with `-t`, or without it llama.cpp's own default (`common_cpu_get_num_math`, uncapped); a spec's
    `plan.n_threads` is never applied, only compared, with a warning when it differs. Leaving `-t` out would
    hand the choice to llama.cpp, not to the spec, so the core keeps it.
  - *Engine gate:* the installed packs are read from `<data>/llamacpp/backends` directly, whichever provider
    runs chat. They are ordered by their tag (`b<build>-<semver>` at or above 1.7.0 first, tags without semver
    next, older tags last, because a `dev` build serves `--decision` under the branch's old number), CPU packs
    first inside a version; the first whose `-h` lists `--decision` (`checkSpecTypeSupport`, cached per
    executable and mtime) is used; an explicit `engine_path` passes the same probe. Once running, the readiness
    chain of DECISION.md must hold: `/health` 200 (polled; 503 while loading), `/v1/models` lists `decision`,
    `/props.decision.api_version == 1`. Only a clear verdict from a 200 answer refuses a build (no `decision`
    capability, no decision block, another API version); a transport error, a request timeout, a 5xx or any
    other non-200 on `/v1/models` or `/props` counts as still loading until the startup deadline, since a
    refusal is remembered and a slow machine must not cost a build. A resolved build that readiness refuses
    (an API version 2 tag, a dev build with an unfinished decision API) is remembered per executable and mtime
    and skipped, and the start resolves again, so a valid lower-ranked build still runs (at most 8 builds per
    start; an explicit `engine_path` has no fallback). The refusals are forgotten when a TurboQuant build is
    installed, on an explicit `load`, and on a start with other launch settings (a refusal may come from the
    spec or the model), not by the background retry. When no build is left it is
    `DECISION_ENGINE_UNSUPPORTED`, state `unsupported`; when builds that list `--decision` were among those
    refused at readiness, the message says so instead of asking for 1.7.0. The background retry of
    `unsupported` announces no `starting` and emits nothing when it fails the same way again. Tags are read
    with `unifiedReleaseRank`, the parser the release index uses.
  - *Supervision:* start and stop are serialized, a stop aborts a start still waiting for readiness, SIGTERM
    then SIGKILL after 5 s. A process that dies after it was ready is restarted after 1, 2, 4, … 30 s, up to
    five restarts in a row; the sixth crash in a row (a minute of uptime resets the count) is `failed`, with
    `restarts: 6`. A start that fails is not retried until a launch setting changes, `load` is called, or a
    TurboQuant build is installed: an install through the core's `/backends/llamacpp/install` (the core emits
    no `backend:download-finished` for its own installs), or a `backend:download-finished` event for
    `llamacpp` with `success`, makes an `unsupported` or `failed` module try again. An `unsupported` module is
    also retried in the background by a call or a public request, at most once per 5 minutes, and the same
    failure again is not a second `decision:error`. A settings write that does not change the launch
    (`timeout_ms`, `idle_unload_secs`, `startup_timeout_secs`) leaves a running process or a start in flight
    alone; the launch key is taken when the start reads the settings. Idle unload is optional
    (`idle_unload_secs`, 0 by default) and a new value re-arms the timer at once.
  - *Calls:* `scoreCandidates(task, criterion, candidates)` and `decide(state, questions)` never throw: every
    way of not answering (off, not configured, unsupported, starting, failed, a 500 ms budget spent, the queue
    full, the router without calibration (`not_calibrated`), the engine refusing the request, a body that cannot
    be serialized, a transport error, a malformed answer, router scores whose ids do not match the candidates in
    order) is `{unavailable: true, reason, message}`, and the caller keeps its default policy. An idle but
    enabled module is started in the background by the first call, which itself answers `starting`.
  - *Uncalibrated router, on purpose:* `allow_uncalibrated` defaults to `false`. Without a router calibration
    the engine's `p_success` is softmax(logits) at T = 1, not a probability, and a routing policy that compares
    it with thresholds and prices would act on numbers that mean nothing; the app must opt in knowingly. So
    with the default settings and the shipped laya-multilingual (no router calibration) the router answers
    `not_calibrated`: without a round trip when `/props.decision.router.available` is `false` (not
    `capabilities`, where `router_score` is missing even with the flag), else from the engine's 501
    `ROUTER_NOT_CALIBRATED`. `/v1/systemone` does not need it and works. `not_calibrated` is a configuration
    state the app can show, unlike `rejected`, which is a caller bug.
  - *Settings:* a `decision` section in `settings.json` (`enabled`, `model_path`, `model_id`, `spec_path`,
    `threads`, `timeout_ms`, `idle_unload_secs`, `startup_timeout_secs`, `allow_uncalibrated`, `engine_path`),
    absent from the file until the first write, checked on write, lenient on read; changes are
    `settings:changed` events with `provider: 'decision'`. The model file lives wherever the app put it; a
    relative path is resolved against the data folder. No new data path.
  - *Surface:* `/atomic/v1/decision/{status,config,load,unload,score,decide}` (snake_case like the engine; score
    and decide answer the fail-open outcome with 200 once the body parses, a malformed body 400
    `INVALID_ARGUMENT`), events `decision:state` (the whole status) and
    `decision:error` (failures nobody awaits), codes `DECISION_NOT_CONFIGURED` (409), `DECISION_ENGINE_UNSUPPORTED`
    (409), `DECISION_UNAVAILABLE` (503). The public server passes `POST /v1/systemone` and
    `POST /v1/router/score` to the process byte for byte (the client's body, the process's key, the engine's
    answer and error envelope unchanged; `model` optional), starting an idle enabled module and waiting up to
    30 s for it while it is starting or restarting (the wait ends early when the client leaves, or when the
    module lands in `failed`, `unsupported` or `disabled`), else 503 in the engine's envelope with
    `reason: UNAVAILABLE`. A start this route triggers reports its failure as a `decision:error`, like a call's. Not through `serveForward`, which
    needs a string `model` and a chat session, and never re-serialized, which would lose `1.0` vs `1`, integers
    past 2^53 and the order of number-like keys.
  - *Classification:* `isDecisionGguf` (architecture `laya`, or any GGUF carrying `decision.layout`, the mirror
    key of `decision.spec`) is checked before `isEmbeddingGguf`, which then answers `false`;
    `ModelCapabilities.isDecision` reports it and `validateGguf` refuses such a file as a text model.
    `laya` stays out of `NON_TEXT_GGUF_ARCHITECTURES`.
  - *Security note:* `engine_path` runs whatever file it names: once for the `-h` probe, then as the server.
    It is writable only through `PUT /atomic/v1/decision/config` (control token) or `settings.json` in the
    data folder, both already able to run code as the user (the backend install routes, the chat providers'
    `version_backend`), so it adds no new privilege; but a UI must never fill it from a model registry, a
    download or any remote input. `model_path` and `spec_path` are only read by the engine.
- **Consequences:** The router survives model switches, the chat auto-unload and the public server's restarts,
  and a router that cannot answer costs a chat turn at most its budget. The shutdown order grows by one step:
  public server, decision process, image engine, chat runtimes. The module needs a fork build of 1.7.0 or newer
  on disk: apps bundled before it, and platforms without fork builds (macOS x64, Windows arm64), report
  `unsupported` and the app keeps its default policy. The fake `llama-server` in `test/helpers` gained a decision
  mode, and now exempts `/v1/health`, `/models` and `/v1/models` from its key gate as the real server does (one
  runtime test moved its unauthorized probe to `/props`). Left to the app: the UI, the pinned model registry
  (URL, size, sha, `min_app_version`), the relay of the two events, the memory budget across chat, decision,
  embeddings and voice, and the routing policy's use of the scores. The app's side of the pair of PRs
  (AGENTS.md rules 4 and 5): (1) relay the codes `DECISION_NOT_CONFIGURED`, `DECISION_ENGINE_UNSUPPORTED` and
  `DECISION_UNAVAILABLE` and the events `decision:state` and `decision:error`; (2) `settings:changed` with
  `provider: 'decision'` is a scope of its own: the app must not mirror it into, or acknowledge it as, a
  legacy provider's settings; (3) the app stops the API server on every model switch (`switchModel.ts`,
  around line 888), so the `:1337` passthrough (`/v1/systemone`, `/v1/router/score`) is down during a
  switch, while the control routes and in-core calls are not; a client of the public routes must expect 503
  or a refused connection then, or the app must stop restarting the server on a switch. Not done here: `CoreClient` methods for the
  new routes, the OpenAPI document, the `semif-letters` layout (Arbiter-4B, JevK5; the engine refuses it at load
  until its release 1.8.0). The control `/decision/decide` re-serializes its body (`1.0` becomes `1`, integers
  past 2^53 lose precision in `state`); byte-exact input exists only on the public routes.
- **Owner:** team.
- **Links:** `src/decision/`, `src/contracts/decision.ts`, `src/settings/decision.ts`,
  `src/server/control/routes/decision.ts`, `src/server/public/decision.ts`, `src/models/gguf/classify.ts`;
  `test/contract/decision.test.ts`, `test/fixtures/decision/engine-examples.json`; the engine contract
  `DECISION.md` in atomic-llama-cpp-turboquant (branch `feature/decision-laya-phase0`).
