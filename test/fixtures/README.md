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
- `host-keys/` — the vendors' public signing keys exactly as served on 2026-09-28 by
  `https://download.docker.com/linux/{ubuntu,fedora}/gpg` (`docker-deb.asc`, `docker-rpm.asc`; Debian's URL
  serves the same file as Ubuntu's) and `https://nvidia.github.io/libnvidia-container/gpgkey`. The install
  recipe pins their fingerprints; `src/host/recipes/openpgp.test.ts` checks them against GnuPG's output.
- Everything else is hand-written test data owned by this repo.
