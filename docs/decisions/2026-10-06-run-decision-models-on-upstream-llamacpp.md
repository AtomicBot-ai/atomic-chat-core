---
date: 2026-10-06
title: "Run upstream decision GGUFs on stock llama.cpp, chosen by the model file"
---

# 2026-10-06 — Run upstream decision GGUFs on stock llama.cpp, chosen by the model file

- **Context:** Until now only the TurboQuant fork served decision models (`llama-server --decision`, ADR
  2026-09-30-the-decision-model-is-its-own-core-module), and the engine gate scanned the fork's packs only.
  Upstream ggml-org llama.cpp now serves decision models natively: from b11370 a GGUF stamped with
  `<arch>.decision.type` (`laya`, `openjev`, `lev`, `kev`, `nimble`) is answered on `POST /v1/systemone`
  (ggml-org/llama.cpp#29818, #29844), `clef` from b11371 (#29831) and clef with images from b11418 (#29969).
  There is no flag: the server reads the type from the file, turns on embedding mode itself for laya, kev and
  clef, and needs the whole prompt in one ubatch for them. It has no `/props.decision`, no `decision`
  capability and no router; `/v1/models` lists `architecture.output_modalities: ["decisions"]` instead, and
  the answer carries only `answers` and `usage`. The fork's and upstream's laya GGUFs are not the same files:
  the fork's carry `decision.layout` or the `laya` architecture, upstream's `modern-bert.decision.type`. The
  app catalogs both kinds (conf `models/decision.json`, `engine` per model), and the upstream manifest is
  still at b11344 when this lands.
- **Decision:** The module stays one module with one process; the model file picks the engine (a
  `DecisionDialect`). A checkpoint folder, or a GGUF without `<arch>.decision.type`, is `turboquant` and
  everything about it is unchanged. A GGUF with it is `upstream`:
  - *Gate:* the packs of `llamacpp-upstream` whose tag `b<N>` is at or above the type's floor
    (`upstream-version.ts`: 11370, clef 11371, clef with a projector 11418), newest first, GPU packs before
    CPU ones. Upstream has no flag to probe, so the tag is the gate and readiness has the last word, with the
    same `reject` skip. No build at the floor → `DECISION_ENGINE_UNSUPPORTED` "Update llama.cpp to b<N> or
    newer", the older packs in its details. An explicit `engine_path` only has to exist.
  - *Launch:* `-m <gguf> [--mmproj <file>] [-a <id>] -c <n> -b <n> [-ub <n> for laya/kev/clef] -t <n>
    --host 127.0.0.1 --port <free> --no-webui`, the key in `LLAMA_API_KEY` as before. No `--device none`:
    upstream decision models run up to 27B parameters and the server's own fitting puts them on the GPU. The
    context is `settings.decision.ctx_size`, or 8192 capped at the trained context.
  - *Readiness:* `/health` 200, then `/v1/models` lists `decisions`. The core stands in the props:
    `{api_version: 1, endpoints: ["/v1/systemone"], source: "gguf", model_id, input_modalities}`.
  - *Endpoints:* `endpoints` in the props is now what decides whether a call may go out, for both engines (the
    fork lists both of its). The router on upstream is `unavailable: 'unsupported'` without a request, and the
    public `/v1/router/score` answers 501 `UNSUPPORTED_ENDPOINT` in the engine's envelope instead of relaying
    llama.cpp's bare 404. `SystemoneResponse` fields only the fork sends are optional.
  - *Settings:* `mmproj_path` (upstream only) and `ctx_size` (0 = automatic). `spec_path` is checked and
    passed only for the fork.
  - *Retries:* a finished install of either provider retries an `unsupported` or `failed` module, but only
    when it is the provider the configured model needs (known once a start has read the file).
  - `isDecisionGguf` also recognises `<arch>.decision.type`, so a chat load of such a file is
    `DECISION_MODEL_NOT_CHAT`, as for the fork's decision GGUFs.
- **Consequences:** The app can offer upstream decision models next to the fork's, and they start as soon as
  the upstream manifest reaches b11370 (b11418 for clef with images); before that the module is `unsupported`
  with the build to update to. Nothing changes for a fork model. The router remains the fork's: a policy that
  scores executors needs a TurboQuant checkpoint. Watch for an upstream build that changes the
  `output_modalities` shape or adds a type with its own floor; the floor table and `WHOLE_PROMPT_DECISION_TYPES`
  are the two places to touch. A PrismML build at or above the floor would serve these files too; it is not
  scanned, since the Prism pin is far below it.
- **Owner:** `team`.
- **Links:** `src/decision/{upstream-version,model-facts,engine,engine-candidates,args,readiness,process,service,wiring}.ts`,
  `src/server/public/decision.ts`, `src/models/gguf/classify.ts`, `test/contract/decision.test.ts`; upstream
  `tools/server/README.md` (`/v1/systemone`), `common/common.cpp` (embedding mode for laya/kev/clef).

<!--
Supersedes: none (extends 2026-09-30-the-decision-model-is-its-own-core-module.md: engines other than the fork)
-->
