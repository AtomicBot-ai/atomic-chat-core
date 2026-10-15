# Live tests

Run only with `ATOMIC_LIVE=1`. Real backend download for the pinned tag, real `llama-server` with a small
GGUF (`ATOMIC_LIVE_UPSTREAM_BIN`, `ATOMIC_LIVE_UPSTREAM_MODEL`, optional `ATOMIC_LIVE_UPSTREAM_TAG`), cloud providers via
`ATOMIC_CLOUD_PROVIDERS` + `ATOMIC_CLOUD_<NAME>_{BASE_URL,API_KEY,MODEL,_STYLE,_TOOLS}` (same contract as the
app's `scripts/record-cloud-live.py`), recording sanitised cassettes into `test/fixtures/live-cloud/`.

Upstream llama.cpp (`test/live/llamacpp.test.ts`): `node scripts/fetch-live-fixtures.mjs --out .live-fixtures [--tag bN]
[--repo owner/name]` downloads the platform's CPU build (newest by default; `--repo AtomicBot-ai/atomic-chat-conf` for the
signed mirror), checks it against the release digest and writes `bin-path.txt`, `model-path.txt`, `tag.txt` and
`fixture.json`. The pack is installed under that tag (`ATOMIC_LIVE_UPSTREAM_TAG`, else `b<build>` from `--version`) and
this host's real backend id (`test/helpers/live-llamacpp.ts`), so the build gates in `planLlamaArgs` run as they would
for a user on that release; the suite checks `--version` against the tag and the gated flags in the argv core logs.

```sh
node scripts/fetch-live-fixtures.mjs --out .live-fixtures
ATOMIC_LIVE=1 ATOMIC_LIVE_UPSTREAM_BIN="$(cat .live-fixtures/bin-path.txt)" \
  ATOMIC_LIVE_UPSTREAM_MODEL="$(cat .live-fixtures/model-path.txt)" \
  ATOMIC_LIVE_UPSTREAM_TAG="$(cat .live-fixtures/tag.txt)" npx vitest run --project live test/live/llamacpp.test.ts
```

On Windows set `ATOMIC_LIVE=1` in the environment and run `npx vitest run --project live`: `npm run test:live` sets it
inline, which cmd.exe cannot parse.

The same variables drive the contract probe (`test/live/llamacpp-contract.test.ts`): it checks the `strings` and `routes`
of `test/fixtures/llamacpp/engine-contract.json` against the real build — readiness and device lines through
`backendOutput`, the session key (401 without it), every route core calls and the fields it reads, a context overflow,
`/metrics` with and without `expose_metrics`, the failures core classifies (a file that is not a GGUF, a truncated one, an
unknown architecture, a known one without its keys, an unknown flag) and `--list-devices`. Only a `break` the contract
expected and did not see fails it; with `ATOMIC_LIVE_REPORT_DIR=<dir>` it writes everything it saw, drift included, to
`<dir>/observed.json` (CI keeps it as the `llamacpp-observed-<os>` artifact of `live-backend`).

Stage 5 providers, each opt-in on its own:

- TurboQuant (`test/live/turboquant.test.ts`): `ATOMIC_LIVE_TURBOQUANT_BIN` (a fork `llama-server`, its whole
  `build/bin` is copied), `ATOMIC_LIVE_TURBOQUANT_MODEL` (a GGUF), optional `ATOMIC_LIVE_TURBOQUANT_TAG`. Checks the
  running process was started with `--cache-type-k/v turbo3`, answers through `/v1`, grows its context.
- Upstream decision model (`test/live/decision-upstream.test.ts`): `ATOMIC_LIVE_UPSTREAM_DECISION_BIN` (an upstream
  `llama-server` b11370 or newer, its whole folder is copied), `ATOMIC_LIVE_UPSTREAM_DECISION_MODEL` (an upstream decision
  GGUF, e.g. `ggml-org/Julia-1-GGUF` Q8_0, 168 MB), optional `ATOMIC_LIVE_UPSTREAM_DECISION_TAG` (default `b11436`). Checks
  the module picks the upstream pack, answers `/v1/systemone` through the public server and refuses the router with 501.
- Embedding model (`test/live/embedding-upstream.test.ts`): `ATOMIC_LIVE_EMBEDDING_BIN` (an upstream `llama-server`, b11454 or
  newer for EmbeddingGemma 2; its whole folder is copied), `ATOMIC_LIVE_EMBEDDING_MODEL` (an embedding GGUF, e.g.
  `unsloth/embeddinggemma-2-GGUF` Q8_0, 310 MB), optional `ATOMIC_LIVE_EMBEDDING_MMPROJ` (its projector, 555 MB) and
  `ATOMIC_LIVE_EMBEDDING_TAG` (default `b11463`). Checks `/v1/embeddings` by the model's name: text ranking, the image of a
  red square nearer "red" than "blue", audio with an audio encoder (400 without), a link refused, `dimensions` refused,
  `/v1/models`, and another name left to the sessions.
- MLX (`test/live/mlx.test.ts`, macOS): `ATOMIC_LIVE_MLX_RESOURCES` (folder with `mlx-server`), `ATOMIC_LIVE_MLX_MODEL`
  (an MLX model folder).
- Foundation Models (`test/live/foundation-models.test.ts`, macOS 26): `ATOMIC_LIVE_FM_RESOURCES` (folder with
  `foundation-models-server`, e.g. `swift build -c release` in the app's `foundation-models-server`). Without Apple
  Intelligence it asserts the classified refusal; with it, a real answer.
- stable-diffusion.cpp (`test/live/diffusion.test.ts`, POSIX): `ATOMIC_LIVE_SD_ENGINE` (folder with `sd-server`, `sd-cli` and
  their libraries; copied into the temporary data folder), `ATOMIC_LIVE_SD_MODEL` (the transformer GGUF), optional
  `ATOMIC_LIVE_SD_VAE`, `ATOMIC_LIVE_SD_VAE_FORMAT` (`flux2` for FLUX.2), `ATOMIC_LIVE_SD_LLM` (the family's text encoder),
  `ATOMIC_LIVE_SD_LLM_VISION` (Qwen Image 2.1's Qwen3-VL projector; with it and `ATOMIC_LIVE_SD_FAMILY=qwen-image-2.1` or
  `qwen-image-2.1-turbo` a `reference` generation from the first output runs as well),
  `ATOMIC_LIVE_SD_FAMILY` (default `flux.2-klein`; `qwen-image-2.1-turbo` runs its 8-step schedule as `custom_sigmas`), `ATOMIC_LIVE_SD_TAG` (the engine's release tag, default
  `master-883-137f740`, the build app v2.0.42 ships). Holds `sd-server --help` to `test/fixtures/sdcpp/required-flags.txt`,
  then finalize → load → a 256² generation with parsed step progress, PNG, thumbnail and recipe → the OpenAI facade → a hard
  cancel of a long job → respawn → unload. About five minutes with FLUX.2 Klein Q4_K_M on an M-series Mac.
  The video block of the same file runs when `ATOMIC_LIVE_SD_VIDEO_MODEL` names a video model (LTX-2.3 distilled by
  default; `ATOMIC_LIVE_SD_VIDEO_VAE`, `ATOMIC_LIVE_SD_AUDIO_VAE`, `ATOMIC_LIVE_SD_VIDEO_LLM`,
  `ATOMIC_LIVE_SD_EMBEDDINGS_CONNECTORS`; `ATOMIC_LIVE_SD_VIDEO_FAMILY=wan2.2-ti2v-5b` with `ATOMIC_LIVE_SD_VIDEO_T5XXL` for
  Wan; `ATOMIC_LIVE_SD_VIDEO_MODE_FLAG=1` also passes `-M vid_gen`): load → a nine-frame clip with parsed step progress,
  the WebM and its sidecar → `/v1/videos` queue, poll and content → a hard cancel → respawn → unload. It prints the
  engine's capabilities and the clip's numbers, which is the evidence the ADR of 2026-09-23 leaves open.

Managed TensorRT-LLM install on Linux (`test/live/managed-install.test.ts`, task 2.18): `ATOMIC_LIVE=1` **and**
`ATOMIC_LIVE_MANAGED=1`, on a throwaway Linux VM with an NVIDIA GPU, driver ≥ the descriptor's minimum and passwordless
sudo. It installs Docker and the NVIDIA Container Toolkit through the core's own recipe, emulates the relogin, pulls the
engine, loads a curated model and streams a chat on `:1337`, then writes `summary.json` for the PR. VM states, build,
exact command and what to attach: [`docs/live-tests.md`](../../docs/live-tests.md).

TensorRT-LLM engine on every NVIDIA card (`test/live/tensorrt-llm.test.ts`, task 2.19): `ATOMIC_LIVE=1` on Linux with
`/usr/bin/nvidia-smi` and the engine already `ready` (after the install test run with
`ATOMIC_LIVE_MANAGED_KEEP_ENGINE=1`, pass its `managed/` folder as `ATOMIC_LIVE_MANAGED_ROOT`). It changes nothing on the host. Per card, pinned through the stored `gpu_id` setting: the
tier's curated model loads as the core's own user, streams on `:1337`, reloads faster from its engine cache, answers
a tool call and a JSON schema, and after `kill -9` of the core its container exits through the watchdog and the card's
memory comes back. With `ATOMIC_LIVE_UPSTREAM_BIN`/`ATOMIC_LIVE_UPSTREAM_MODEL` it also races a reload against a
llama.cpp GPU load. It writes the measured
heartbeat, watchdog, `--shm-size`, memory-limit and load-timeout values into `summary.json` for an ADR. Prerequisites,
exact command and how to carry the results into an ADR and conf: [`docs/live-tests.md`](../../docs/live-tests.md).
