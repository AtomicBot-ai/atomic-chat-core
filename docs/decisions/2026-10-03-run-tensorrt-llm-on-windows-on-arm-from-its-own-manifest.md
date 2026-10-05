---
date: 2026-10-03
title: "Run TensorRT-LLM on Windows on Arm from a manifest of its own"
---

# 2026-10-03 — Run TensorRT-LLM on Windows on Arm from a manifest of its own

- **Context:** The Windows path (change `add-tensorrt-llm-windows`) left Windows on Arm out: `assessWindowsHost` answered `unsupported-architecture` for anything but x64, and the guest recipe was run with `arch: 'x86_64'`. NVIDIA now ships Windows on Arm machines with its GPUs (RTX Spark N1X, R616 driver) and CUDA on Arm64, while the Linux path already runs TensorRT-LLM on `aarch64` (`linux/arm64` image in the descriptor, the recipe qualified for `aarch64`).
- **Decision:** A Windows on Arm core reads its own environment manifest, `runtimes/environments/windows-arm64.json` (id `windows-arm64-r<N>`, an `aarch64` rootfs), chosen from the host's `os.machine()`; an x64 core keeps reading `windows.json`. The parser accepts an `aarch64` rootfs only under a `windows-arm64-` id and an `x86_64` one only under `windows-r`. The plan offers the setup on `x86_64` and `aarch64` when the manifest's rootfs matches the machine, and the guest recipe runs for the machine's architecture. A separate file, not a second rootfs in `windows.json`: every released core parses `windows.json` strictly and would refuse it, hiding TensorRT-LLM from every x64 user.
- **Consequences:** Nothing changes on x64. Windows on Arm stays `unsupported` until conf publishes `windows-arm64.json` — the switch is data, as for x64 (2026-10-01). No live acceptance on an N1X machine yet; the NVIDIA Windows on Arm driver and CUDA are developer previews.
- **Owner:** `team`
- **Links:** `src/runtime/environment/environment-manifest.ts`, `environment-manifest-provider.ts`, `windows-plan.ts`, `windows-provisioner.ts`, `wiring.ts`; tests beside each.
