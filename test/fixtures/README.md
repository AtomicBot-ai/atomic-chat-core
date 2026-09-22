# Fixtures

- `app/` — contract fixtures emitted by the app's Rust tests (`cargo test -- --ignored dump_fixtures` in
  `../Atomic-Chat/src-tauri`) and copied here by `npm run fixtures:import`. `app/CHECKSUM` must match the
  checksum recorded in the app repo (`tests/core-contracts.test.mjs`). Never edit by hand; changing a
  fixture requires an ADR.
- `live-cloud/` — sanitised cassettes recorded by the live cloud tests (same format as the app's
  `tests/fixtures/live-cloud`).
- `png/` — small PNGs for `src/diffusion/png.ts`, written by `png/generate.py` (its encoder is not the core's, and
  Pillow cross-checks every supported file). `sdcpp/required-flags.txt` — every flag the core passes to `sd-server`.
- Everything else is hand-written test data owned by this repo.
