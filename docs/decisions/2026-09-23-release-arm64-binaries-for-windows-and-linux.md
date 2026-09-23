---
date: 2026-09-23
title: "Release arm64 binaries for Windows and Linux, proven on native arm runners"
---

# 2026-09-23 — Release arm64 binaries for Windows and Linux, proven on native arm runners

- **Context:** a release carried both binaries for four targets: macOS arm64 and x64, Windows x64, Linux x64. The
  app's `scripts/download-core.mjs` already asks for `aarch64-unknown-linux-gnu` on a Linux arm64 host and found
  nothing there; on Windows it asks only for x64. Bun 1.3.10, the version CI pins, is the first to ship a native
  Windows arm64 runtime (Linux arm64 it has had for long), and `oven-sh/setup-bun` installs it on a Windows arm
  runner from that version on. On a Linux arm64 host `build-binaries.mjs --host` silently built the x64 binary.
- **Decision:** `scripts/build-binaries.mjs` knows six targets, adding `bun-windows-arm64` →
  `aarch64-pc-windows-msvc` and `bun-linux-arm64` → `aarch64-unknown-linux-gnu`, and `--host` follows the host's
  arch on every OS. The release cross-compiles all six on its Linux host as before and publishes twelve binaries
  under `SHA256SUMS`. The CI `test` job, which is also the release gate, runs on native `ubuntu-24.04-arm` and
  `windows-11-arm` runners as well, so an arm64 binary is never released without the unit, contract,
  runtime-compat and binary e2e suites having passed on that arch; the nightly `live-backend` job runs there too,
  against the upstream `ubuntu-arm64` / `win-cpu-arm64` `llama-server`.
- **Consequences:** the arm64 Windows and Linux binaries are for the CLI and library hosts. The app keeps shipping x64
  only on Windows and Linux and does not take them (owner decision, 2026-09-23): an arm64 app would also need what
  upstream does not publish today (stable-diffusion.cpp for either OS, cloudflared and sqlite-vec for Windows arm64, a
  TurboQuant CPU build) and arm64 packs in the atomic-chat-conf mirror. A red or unavailable arm runner now blocks a
  release.
  This record does not change the llama.cpp backend catalog, which keeps the app's behaviour: on Linux arm64 and
  Windows arm64 it lists no upstream pack (only TurboQuant's `linux-arm64-cuda-13.3`), so local inference there runs
  only on a pack already on disk. Offering the upstream arm64 packs (`win-cpu-arm64`, `ubuntu-arm64`, and their
  Vulkan and CUDA builds) is a separate decision.
- **Owner:** team.
- **Links:** `scripts/build-binaries.mjs`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`;
  `src/backend/catalog/manifest.ts` (`parseManifestForPlatform`); the app's `scripts/download-core.mjs`.
