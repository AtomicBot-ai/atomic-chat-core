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

To check a whole llama.cpp build against this core — the surface diff plus these tests on the build and on the pin — run
`npm run engine:check -- --tag bN` (or `--repo …`, `--bin …`); see `docs/live-tests.md`, "Checking a llama.cpp build".

On Windows set `ATOMIC_LIVE=1` in the environment and run `npx vitest run --project live`: `npm run test:live` sets it
inline, which cmd.exe cannot parse.

The same variables drive the contract probe (`test/live/llamacpp-contract.test.ts`): it checks the `strings` and `routes`
of `test/fixtures/llamacpp/engine-contract.json` against the real build — readiness and device lines through
`backendOutput`, the session key (401 without it), every route core calls and the fields it reads, a context overflow,
`/metrics` with and without `expose_metrics`, the failures core classifies (a file that is not a GGUF, a truncated one, an
unknown architecture, a known one without its keys, an unknown flag) and `--list-devices`. Only a `break` the contract
expected and did not see fails it; with `ATOMIC_LIVE_REPORT_DIR=<dir>` it writes everything it saw, drift included, to
`<dir>/observed.json` (CI keeps it as the `llamacpp-observed-<os>` artifact of `live-backend`).

PrismML (`test/live/prism.test.ts`): `ATOMIC_LIVE_PRISM_BIN` (a `llama-server` from a PrismML-Eng/llama.cpp
`llama-prism-<tag>-bin-<platform>` archive), `ATOMIC_LIVE_PRISM_MODEL` (a Bonsai GGUF with PrismML tensor types),
`ATOMIC_LIVE_PRISM_TAG` (the `prism-b<N>-<sha7>` tag; required, the build alone does not name it). The pack is installed
under that tag and this host's PrismML CPU pack id; the suite runs the install gate (`--version` names the tag's build),
`-h` against the engine contract, and a load on `atomic-prism` that answers. `node scripts/fetch-live-fixtures.mjs --out
.live-prism --repo PrismML-Eng/llama.cpp --tag <tag> --engine atomic-prism` fetches the build and
`Ternary-Bonsai-1.7B-PQ2_0.gguf`; `npm run engine:check -- --engine atomic-prism --tag <tag>` runs the whole check.

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
  (an MLX model folder). Holds `mlx-server --help` to every flag and choice the core passes, loads the folder and answers
  through the public API, and asks for a json_schema `response_format`, which has to come back as JSON that follows the
  schema (a frozen build without its structured-output engine answers prose). `test/live/mlx-install.test.ts` takes
  `ATOMIC_LIVE_MLX_MANIFEST` (a conf-shaped MLX manifest, a path or an `https://` URL such as conf's
  `backends/mlx-manifest.json` on raw.githubusercontent.com; Apple Silicon only) and installs its build the way a user
  gets it: picked, downloaded, size and sha256 checked, unpacked and probed (`--help`), ordered by the manifest's
  `published_at`; a tampered sha256 refused. About 210 MB downloaded twice. A manifest naming a fork release by its
  upstream tag (`v0.7.12`) skips it: cores install only `mlxvlm-macos-arm64-<hex>`, conf's mirror's name.
  `node scripts/fetch-live-fixtures.mjs --engine mlx --tag <tag> [--repo …] --out .live-mlx` fetches a release, its
  manifest, SmolLM2-135M-Instruct 8-bit (141 MB, every file pinned by revision and sha256) and `help.txt`, and writes
  `live.json` for the config's `live_env`; `npm run engine:check -- --engine mlx --tag <tag>` runs the whole check.
- Foundation Models (`test/live/foundation-models.test.ts`, macOS 26): `ATOMIC_LIVE_FM_RESOURCES` (folder with
  `foundation-models-server`, e.g. `swift build -c release` in the app's `foundation-models-server`). Without Apple
  Intelligence it asserts the classified refusal; with it, a real answer.
- stable-diffusion.cpp (`test/live/diffusion.test.ts`, POSIX): `ATOMIC_LIVE_SD_ENGINE` (folder with `sd-server`, `sd-cli` and
  their libraries; copied into the temporary data folder), `ATOMIC_LIVE_SD_MODEL` (the transformer GGUF), optional
  `ATOMIC_LIVE_SD_VAE`, `ATOMIC_LIVE_SD_VAE_FORMAT` (`flux2` for FLUX.2), `ATOMIC_LIVE_SD_LLM` (the family's text encoder),
  `ATOMIC_LIVE_SD_LLM_VISION` (Qwen Image 2.1's Qwen3-VL projector; with it and `ATOMIC_LIVE_SD_FAMILY=qwen-image-2.1` or
  `qwen-image-2.1-turbo` a `reference` generation from the first output runs as well),
  `ATOMIC_LIVE_SD_FAMILY` (default `flux.2-klein`; `qwen-image-2.1-turbo` runs its 8-step schedule as `custom_sigmas`), `ATOMIC_LIVE_SD_TAG` (the engine's release tag, default
  `master-883-137f740`, the build app v2.0.42 ships), `ATOMIC_LIVE_SD_BACKEND=cpu` (every load on the CPU backend, as on
  CI runners). Holds `sd-server --help` to the `break` flags of `test/fixtures/sdcpp/engine-contract.json`, alias by alias,
  then finalize → load → a 256² generation with parsed step progress, PNG, thumbnail and recipe → the OpenAI facade → a hard
  cancel of a long job → respawn → unload. About five minutes with FLUX.2 Klein Q4_K_M on an M-series Mac.
  The video block of the same file runs when `ATOMIC_LIVE_SD_VIDEO_MODEL` names a video model (LTX-2.3 distilled by
  default; `ATOMIC_LIVE_SD_VIDEO_VAE`, `ATOMIC_LIVE_SD_AUDIO_VAE`, `ATOMIC_LIVE_SD_VIDEO_LLM`,
  `ATOMIC_LIVE_SD_EMBEDDINGS_CONNECTORS`; `ATOMIC_LIVE_SD_VIDEO_FAMILY=wan2.2-ti2v-5b` with `ATOMIC_LIVE_SD_VIDEO_T5XXL` for
  Wan; `ATOMIC_LIVE_SD_VIDEO_MODE_FLAG=1` also passes `-M vid_gen`): load → a nine-frame clip with parsed step progress,
  the WebM and its sidecar → `/v1/videos` queue, poll and content → a hard cancel → respawn → unload. It prints the
  engine's capabilities and the clip's numbers, which is the evidence the ADR of 2026-09-23 leaves open.
  `test/live/diffusion-install.test.ts` takes `ATOMIC_LIVE_SD_MANIFEST` (a conf-shaped sd.cpp manifest, a path or an
  `https://` URL) and installs its build the way a user gets it: picked for the host, downloaded, checked, unpacked and
  probed; a tampered sha256 refused; `--version` naming the tag's commit. `node scripts/fetch-live-fixtures.mjs --engine
  sd-cpp --tag <tag> --out .live-sd` fetches a release, its manifest and FLUX.2 Klein for both files, and
  `npm run engine:check -- --engine sd-cpp --tag <tag>` runs the whole check.
- audio.cpp (`test/live/audio-install.test.ts`): installs a real build the way a user gets it, from a manifest of conf's
  shape (`ATOMIC_AUDIOCPP_MANIFEST_URL`): picked for the host, downloaded, size and sha256 checked, unpacked and probed
  (`--version`, and `--list-devices` for a GPU build); a tampered sha256 refused; `--version` naming the tag's `X.Y.Z`.
  `ATOMIC_LIVE_AUDIO_MANIFEST` (a path or an `https://` URL, such as conf's `backends/audiocpp-manifest.json` on
  raw.githubusercontent.com) picks the manifest; without it the test installs from conf's bootstrap staging manifest
  (`test/fixtures/audiocpp/conf/audiocpp-manifest.staging.json`: upstream `0xShug0/audio.cpp` v0.9.3, which has no
  Linux or Windows arm64 build). It downloads this host's archive twice: 35 MB on an Apple Silicon Mac.
  `node scripts/fetch-live-fixtures.mjs --engine audio-cpp --tag <tag> [--repo …] --out .live-audio` fetches a release,
  its manifest, MOSS-TTS-Nano-100M q8 (193 MB, pinned by revision and sha256) and the build's `--help`, `--version` and
  `--list-devices` (`help.txt`, `version.txt`, `list-devices.txt`), and writes `live.json` for the config's `live_env`:
  `ATOMIC_LIVE_AUDIO_ENGINE` (the unpacked build), `ATOMIC_LIVE_AUDIO_TAG`, `ATOMIC_LIVE_AUDIO_MANIFEST`,
  `ATOMIC_LIVE_AUDIO_MODEL` (MOSS-TTS-Nano), `ATOMIC_LIVE_AUDIO_FAMILY=moss_tts_nano`, `ATOMIC_LIVE_AUDIO_TASK=tts`,
  `ATOMIC_LIVE_AUDIO_MODE=speech` and `ATOMIC_LIVE_AUDIO_BACKEND=cpu`, which `test/live/audio.test.ts` reads.
  `npm run engine:check -- --engine audio-cpp --tag <tag>` runs the whole check.
- audio.cpp runtime (`test/live/audio.test.ts`): `ATOMIC_LIVE_AUDIO_ENGINE` (a folder holding `audiocpp_server`) and
  `ATOMIC_LIVE_AUDIO_MODEL` (a GGUF, read where it is) turn it on; `ATOMIC_LIVE_AUDIO_FAMILY` (default `moss_tts_nano`),
  `ATOMIC_LIVE_AUDIO_MODE` (`speech`, `music` or `effects`, default `speech`), `ATOMIC_LIVE_AUDIO_TASK` (default the
  mode's: `tts` for speech, `gen` otherwise), `ATOMIC_LIVE_AUDIO_TAG` (default `v0.9.3`), `ATOMIC_LIVE_AUDIO_BACKEND=cpu`
  (every load on the CPU backend through `ATOMIC_AUDIO_BACKEND`, as on CI runners). The build goes into the temporary
  data folder as `<data>/audio/backends/<tag>/<host's CPU backend id>/` with the real probe and an `install.json`, or,
  with `ATOMIC_LIVE_AUDIO_MANIFEST`, is installed through that manifest. Holds `audiocpp_server --help` to every flag
  `buildAudioServerArgs` passes and every route of `test/fixtures/audiocpp/engine-contract.json`, then load →
  capabilities and the contract's load lines in the engine's real output → one job (speech: a sentence; music and
  effects: `durationSec` 3) with its WAV, recipe and gallery item → a long job (a long text, or 120 s) cancelled while it
  generates, the server stopped → the next job respawns it → unload. A model that speaks only in a cloned voice
  (`requiresVoiceRef`: Qwen3-TTS Base) needs `ATOMIC_LIVE_AUDIO_VOICE_REF` (a WAV) and
  `ATOMIC_LIVE_AUDIO_REFERENCE_TEXT` (its transcript); without them the generation is skipped with that message.
  No build carries eSpeak-ng (upstream's never did; the fork leaves it out, ADR 2026-10-29), so Kokoro refuses every
  speech request (`Could not load eSpeak-ng`). MOSS-TTS-Nano, Qwen3-TTS, Stable Audio and ACE-Step need none, e.g.:

  ```sh
  ATOMIC_LIVE=1 ATOMIC_LIVE_AUDIO_ENGINE=<dir with audiocpp_server> \
    ATOMIC_LIVE_AUDIO_MODEL=<models>/stable-audio-3-small-sfx-q8_0.gguf ATOMIC_LIVE_AUDIO_FAMILY=stable_audio \
    ATOMIC_LIVE_AUDIO_MODE=effects npx vitest run --project live test/live/audio.test.ts
  ATOMIC_LIVE=1 ATOMIC_LIVE_AUDIO_ENGINE=<dir with audiocpp_server> \
    ATOMIC_LIVE_AUDIO_MODEL=<models>/qwen3-tts-12hz-0.6b-base-q8_0.gguf ATOMIC_LIVE_AUDIO_FAMILY=qwen3_tts \
    ATOMIC_LIVE_AUDIO_VOICE_REF=<ref.wav> ATOMIC_LIVE_AUDIO_REFERENCE_TEXT="<what ref.wav says>" \
    npx vitest run --project live test/live/audio.test.ts
  ```

  Each run prints `live audio capabilities` and `live audio run` (load, job, engine and cancel times, the clips' length).
  On an M4 Pro with upstream v0.9.3: Stable Audio 3 Small SFX q8 about 9 s on Metal and 25 s on the CPU, Qwen3-TTS
  0.6B Base q8 about 14 s on Metal and 22 s on the CPU.

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
