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
- `linux-probe/nvidia-smi/gb10-driver595-captured.csv` (core's own `noheader,nounits` query),
  `gb10-driver595-captured-with-header.csv` (the same query with `--format=csv`) and
  `linux-probe/meminfo/gb10-captured-head.txt` (the first five lines of `/proc/meminfo`) are verbatim captures from a
  DGX Spark-class GB10 host (a vast.ai container, driver 595.71.05 injected by the host). `*-documented.csv` (GH200,
  RTX 5090) are built from NVIDIA's published memory sizes and compute capabilities, not captured.
- `core-log/` — `sample.log` pins `core.log`'s on-disk format as a core → app contract: unlike `app/`, the
  core is the source of truth here, and the app copies this file into its own tests. Produced and replayed
  by `test/contract/core-log.test.ts`; see `core-log/README.md`.
- `runtimes/` — verbatim copies of published conf documents: `tensorrt-llm.json` is
  `atomic-chat-conf/runtimes/tensorrt-llm.json` (`tensorrt-llm-1.2.1-r2`) and `environments/linux.json` is
  `atomic-chat-conf/runtimes/environments/linux.json` (`linux-r1`), both as of conf commit `2676324`. Replace a file
  with conf's, never edit it by hand: the parsers are tested against what conf CI accepted.
- Everything else is hand-written test data owned by this repo.
