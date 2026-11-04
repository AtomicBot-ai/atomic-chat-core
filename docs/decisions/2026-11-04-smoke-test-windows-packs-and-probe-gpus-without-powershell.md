---
date: 2026-11-04
title: "Smoke-test Windows engine packs, retry locked moves, and find GPUs without PowerShell"
---

# 2026-11-04 — Smoke-test Windows engine packs, retry locked moves, and find GPUs without PowerShell

- **Context:** A Windows llama.cpp pack was never started before its first model load, so a pack with a missing
  or quarantined DLL failed there with empty stderr. The final staging rename ran once, while Defender and the
  indexer hold freshly written files (EPERM/EBUSY/EACCES), and install errors carried no disk tag. The cudart
  companion was fetched without a checksum and a failed cudart preflight only warned. The Windows hardware probe
  is one PowerShell script; when PowerShell is blocked or WMI is broken only nvidia-smi GPUs survived, AMD and
  Intel cards vanished, and the failed result was cached for the core's lifetime ("No GPU detected" 1.5% of
  Windows senders, 0% elsewhere).
- **Decision:** On win32, upstream and TurboQuant packs run `llama-server.exe --version` from staging with the
  runtime's environment before they are installed; a refused start or non-zero exit fails the install with
  `ENGINE_BINARY_BROKEN` / `CPU_INSTRUCTION_UNSUPPORTED` and a diag line, and staging is removed (a timeout passes
  with a warning). Moves and removes in install retry Windows lock errors for up to 10 s, then fail with a disk
  tag (`disk_file_locked`, `disk_permission`, `disk_full`; new `disk_fs_limit` for EFBIG and FAT's 4 GiB limit).
  A Windows CUDA pack is installed only with its whole CUDA runtime in `build/bin` — `cudart64_<N>`,
  `cublas64_<N>` and `cublasLt64_<N>` (the contents of ggml-org's companion zips). What the archive and its
  companion did not bring is delivered from the best source the machine has, offline first: another installed
  pack of the same CUDA major and at least the same minor (or the legacy `llamacpp/lib`), a host CUDA toolkit
  (`bin\x64` for CUDA 13, `bin` for 12), the pack's own ggml-org companion, NVIDIA's redistributable
  `cuda_cudart` + `libcublas` archives from the nearest `redistrib_<X.Y.Z>.json` (sha256-checked), then pinned
  ggml-org companions (12.4, 13.3, 13.4 x64 and arm64); a source counts only when it supplies every missing DLL.
  Only when none can is the install refused with `ENGINE_BINARY_BROKEN`, naming the sources tried; `--version` does not load the CUDA backend, so the launch
  check alone cannot see a missing runtime. A TurboQuant pack whose runtime repair fails is refused, no longer
  installed with a warning. The load-time repair counts a pack as ready only with the whole set. The companion's
  sha256 and size come from the release list when it lists the asset, and from pinned GitHub digests for the
  b10205 companions TurboQuant uses; a failed load-time repair with no CUDA toolkit on the host hides CUDA from
  that provider's selection for the run. When PowerShell fails
  or finds no video controller, non-recursive `reg.exe` queries of the display class recover each adapter's
  name, vendor and VRAM (`gpu_source: 'registry'`); a degraded probe is re-run after 60 s, doubling to 15 min.
- **Consequences:** A broken pack fails at install, where a retry downloads it again, instead of at every load.
  Windows e2e installs pack System32 `curl.exe` as a stand-in `llama-server.exe`. The registry cannot tell a
  phantom adapter from a present one, and identical non-NVIDIA cards collapse into one entry. A CUDA pack without
  its runtime never reaches backend selection, so it cannot quietly run on the CPU. Not verified on a Windows machine at the
  time of writing.
- **Owner:** `team`
- **Links:** `src/backend/install/{service,windows-launch-check,cuda-guard}.ts`, `src/downloads/{fs-retry,disk}.ts`,
  `src/hardware/{probe-windows,windows-registry,service}.ts`, `src/contracts/{errors,hardware}.ts`.
