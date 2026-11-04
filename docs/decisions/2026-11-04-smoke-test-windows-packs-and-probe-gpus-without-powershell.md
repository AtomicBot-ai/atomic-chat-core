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
  The companion's sha256 and size come from the release list when it lists the asset, and a failed cudart repair
  with no CUDA toolkit on the host hides CUDA from that provider's selection for the run. When PowerShell fails
  or finds no video controller, non-recursive `reg.exe` queries of the display class recover each adapter's
  name, vendor and VRAM (`gpu_source: 'registry'`); a degraded probe is re-run after 60 s, doubling to 15 min.
- **Consequences:** A broken pack fails at install, where a retry downloads it again, instead of at every load.
  Windows e2e installs pack System32 `curl.exe` as a stand-in `llama-server.exe`. The registry cannot tell a
  phantom adapter from a present one, and identical non-NVIDIA cards collapse into one entry. The TurboQuant
  cudart repair in `turboquant.ts` still downloads without a checksum. Not verified on a Windows machine at the
  time of writing.
- **Owner:** `team`
- **Links:** `src/backend/install/{service,windows-launch-check,cuda-guard}.ts`, `src/downloads/{fs-retry,disk}.ts`,
  `src/hardware/{probe-windows,windows-registry,service}.ts`, `src/contracts/{errors,hardware}.ts`.
