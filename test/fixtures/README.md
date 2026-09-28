# Fixtures

- `app/` — contract fixtures emitted by the app's Rust tests (`cargo test -- --ignored dump_fixtures` in
  `../Atomic-Chat/src-tauri`) and copied here by `npm run fixtures:import`. `app/CHECKSUM` must match the
  checksum recorded in the app repo (`tests/core-contracts.test.mjs`). Never edit by hand; changing a
  fixture requires an ADR.
- `live-cloud/` — sanitised cassettes recorded by the live cloud tests (same format as the app's
  `tests/fixtures/live-cloud`).
- `png/` — small PNGs for `src/diffusion/png.ts`, written by `png/generate.py` (its encoder is not the core's, and
  Pillow cross-checks every supported file). `sdcpp/required-flags.txt` — every flag the core passes to `sd-server`.
- `hardware/` — recorded tool output for the hardware probe's parsers (`/proc/cpuinfo`, `nvidia-smi`, `vulkaninfo`,
  the Windows PowerShell document); `hardware/README.md` names each file's machine and marks the synthetic ones.
- `core-log/` — `sample.log` pins `core.log`'s on-disk format as a core → app contract: unlike `app/`, the
  core is the source of truth here, and the app copies this file into its own tests. Produced and replayed
  by `test/contract/core-log.test.ts`; see `core-log/README.md`.
- Everything else is hand-written test data owned by this repo.
