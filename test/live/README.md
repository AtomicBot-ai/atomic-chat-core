# Live tests

Run only with `ATOMIC_LIVE=1`. Real backend download for the pinned tag, real `llama-server` with a small
GGUF (`ATOMIC_LIVE_UPSTREAM_BIN`, `ATOMIC_LIVE_UPSTREAM_MODEL`), cloud providers via
`ATOMIC_CLOUD_PROVIDERS` + `ATOMIC_CLOUD_<NAME>_{BASE_URL,API_KEY,MODEL,_STYLE,_TOOLS}` (same contract as the
app's `scripts/record-cloud-live.py`), recording sanitised cassettes into `test/fixtures/live-cloud/`.

Stage 5 providers, each opt-in on its own:

- TurboQuant (`test/live/turboquant.test.ts`): `ATOMIC_LIVE_TURBOQUANT_BIN` (a fork `llama-server`, its whole
  `build/bin` is copied), `ATOMIC_LIVE_TURBOQUANT_MODEL` (a GGUF), optional `ATOMIC_LIVE_TURBOQUANT_TAG`. Checks the
  running process was started with `--cache-type-k/v turbo3`, answers through `/v1`, grows its context.
- MLX (`test/live/mlx.test.ts`, macOS): `ATOMIC_LIVE_MLX_RESOURCES` (folder with `mlx-server`), `ATOMIC_LIVE_MLX_MODEL`
  (an MLX model folder).
- Foundation Models (`test/live/foundation-models.test.ts`, macOS 26): `ATOMIC_LIVE_FM_RESOURCES` (folder with
  `foundation-models-server`, e.g. `swift build -c release` in the app's `foundation-models-server`). Without Apple
  Intelligence it asserts the classified refusal; with it, a real answer.
- stable-diffusion.cpp (`test/live/diffusion.test.ts`, POSIX): `ATOMIC_LIVE_SD_ENGINE` (folder with `sd-server`, `sd-cli` and
  their libraries; copied into the temporary data folder), `ATOMIC_LIVE_SD_MODEL` (the transformer GGUF), optional
  `ATOMIC_LIVE_SD_VAE`, `ATOMIC_LIVE_SD_VAE_FORMAT` (`flux2` for FLUX.2), `ATOMIC_LIVE_SD_LLM` (the family's text encoder),
  `ATOMIC_LIVE_SD_FAMILY` (default `flux.2-klein`). Holds `sd-server --help` to `test/fixtures/sdcpp/required-flags.txt`,
  then finalize → load → a 256² generation with parsed step progress, PNG, thumbnail and recipe → the OpenAI facade → a hard
  cancel of a long job → respawn → unload. About five minutes with FLUX.2 Klein Q4_K_M on an M-series Mac.
