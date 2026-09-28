---
date: 2026-09-27
title: "The core probes hardware with shell tools and is the only source of hardware facts"
---

# 2026-09-27 — The core probes hardware with shell tools and is the only source of hardware facts

- **Context:** PLAN.md §2 decision 10 made the desktop app the measurer of the machine: `tauri-plugin-hardware`
  read NVML and Vulkan and injected the result through `PUT /atomic/v1/hardware/override` before the first load.
  `src/hardware/` held only that override; every consumer passed an empty probe, so a core without the app
  (the CLI, a library host, a core the app had not yet attached to) believed "no GPU, no AVX" and chose the
  CPU build. Two descriptions of the same machine also meant two selectors that could disagree.
- **Decision:** The core measures the machine itself and is the only source of hardware facts. `HardwareService`
  runs one probe per core start (eagerly, never blocking the ready line; `POST /hardware/refresh` re-runs it)
  with tools every host has: `nvidia-smi` for NVIDIA driver version and compute capability (it is an NVML
  client, so the numbers are NVML's), DRM sysfs on Linux and one PowerShell CIM + registry document on Windows
  for the other PCI GPUs, their device ids and VRAM, `/proc/cpuinfo` / `sysctl` / `IsProcessorFeaturePresent`
  for the CPU flags, the Vulkan loader's ICD registrations and `vulkaninfo` when present. No NVML, no native
  addon, no new dependency; every tool is an injected `run`/`fs` so Windows branches are tested on macOS. The
  result is served as `GET /hardware/info` in the plugin's `SystemInfo` shape plus two fields the plugin never
  emitted: `cpu.extensions_known` (unknown flags are not an empty list, so the no-AVX preflight cannot fire on
  ignorance) and `vulkan_info.device_type: 'Unknown'`. macOS reports `gpus: []` as the plugin did. Nothing is
  persisted. `PUT /hardware/override` stays as a seam that replaces the probe wholesale; the app stops using it.
- **Consequences:** Headless and CLI hosts get real facts. What gets worse against NVML/vulkano: Vulkan
  `device_type` and `api_version` are exact only when `vulkaninfo` is installed, otherwise a vendor heuristic or
  `'Unknown'`, so `integratedGpuOnly` proves "integrated only" less often and an APU with a ≥ 2 GiB carve-out may
  be offered Vulkan; non-NVIDIA `uuid` and `driver_version` are opaque OS strings (the app's System Monitor
  matches its usage rows by name/index, not uuid); AMD/Intel VRAM falls back to `AdapterRAM` (4 GiB cap) when the
  registry lacks `qwMemorySize`, which can fail TurboQuant's 6 GiB gate; a Linux NVIDIA host without a working
  `nvidia-smi` has no CUDA tier; the first Windows load waits for a PowerShell cold start (≤ 15 s). The
  existing `--list-devices` tier check (`tierEnumeratesDevices`) remains the runtime corroboration. Windows 10
  builds below 20348 answer `false` for unknown processor-feature numbers, so their flags read as unknown.
- **Owner:** team.
- **Links:** `src/hardware/`, `src/contracts/hardware.ts`, `src/server/control/routes/hardware.ts`,
  `test/e2e/hardware.test.ts`, `test/fixtures/hardware/`, PLAN.md §2 decision 10 (revised), risk 10; the app
  ADR of the same date in `../Atomic-Chat/docs/decisions/`.

<!--
Supersedes: the "the core cannot and will not" half of PLAN.md §2 decision 10 (2026-09-16 journal, stage 3b).
-->
