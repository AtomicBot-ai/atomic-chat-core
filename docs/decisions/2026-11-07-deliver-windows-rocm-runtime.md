---
date: 2026-11-07
title: "Deliver the Windows ROCm runtime with upstream llama.cpp"
---

# 2026-11-07 — Deliver the Windows ROCm runtime with upstream llama.cpp

- **Context:** The b12019 Windows ROCm 10.0 archive ships ggml-hip and HIP/compiler DLLs,
  but omits hipBLAS/rocBLAS and GPU kernels. `--version` succeeds while `--list-devices`
  reports no GPU, making a nominal ROCm installation silently use the CPU.
- **Decision:** Core downloads AMD's version-pinned `rocm-sdk-libraries` and one
  `rocm-sdk-device-<gfx>` wheel per known AMD GPU during backend installation. PCI-to-gfx
  selection reuses the hardware eligibility table; there is no name-based guess. Extract the
  portable libraries beside the engine, preserving `bin` relative to `.kpack` and the original
  package metadata. Do not install Python, a system SDK, a driver, or change the system PATH.
  Verify wheel RECORD SHA-256 entries at install time; pin reviewed whole-archive digests
  (libraries and gfx1152). AMD's index does not publish digests; other architecture wheels
  currently rely on the official HTTPS origin plus RECORD integrity, not independently pinned
  archive authentication. Retain notices and metadata supplied in the original packages.
- **Consequences:** Installation requires an additional ~251 MB download on gfx1152 and space
  for the expanded portable runtime. A HIP device must enumerate before success is recorded;
  no CPU-only success. Failed new installs retain the previous pack. Existing incomplete
  installs repair before load or when installed again, serialized per pack and refused while
  the pack is in use. Later loads read a small receipt and stat essential files, never hash
  large payloads. A changed GPU target set or missing DLL/kernel triggers repair. ROCm errors
  propagate outside the CUDA guard, so AMD failures cannot disable NVIDIA selection.
  Only the matching ROCm 10.0 ABI has automatic delivery today; complete older bundles keep
  their runtime, incomplete unsupported ABIs fail explicitly. Vulkan, Linux and self-contained
  Prism packs are unchanged. Drivers remain a separate prerequisite.
- **Validation:** Eight targeted tests cover package selection, proxy/task continuity, integrity,
  repeat-load caching, missing-file repair, active-pack refusal, old-install repair and failed
  staging rollback. Actual AMD 10.0 wheels passed the same RECORD/extraction implementation.
  Windows 11 acceptance on Radeon 860M (gfx1152), driver 32.0.31044.1004, used the compiled
  atc binary (SHA-256 `834c106a1a48798b01f96602ce53555f5b70759117c70b33ce3139d6f798182d`).
  The old pack initially had no hipblas.dll or receipt. Core delivered AMD 10.0.0 libraries and
  gfx1152 kernels through the normal engine-install operation. The direct AMD CDN body stalled
  on this host; the successful download used the request's supported proxy field via a temporary
  CONNECT tunnel, with end-to-end TLS and pinned hashes, no manually supplied DLLs, no persistent
  proxy configuration. After removing the tunnel, a normal model load and chat through atc
  succeeded: Qwen3-0.6B-Q4_K_M, ROCm0, 29/29 layers on GPU, 372.65 MiB model buffer and 112 MiB
  GPU KV buffer. Startup took 1.61 seconds; the model replied "Hello! How can I assist you today?".
  The default API log tail omitted startup offload lines; the complete engine log confirmed them
  after a diagnostic verbosity override. No full test suite or aggregate verify was run.
- **Owner:** team.
- **Links:** [AMD portable installation](https://rocm.docs.amd.com/en/docs-10.0.0/install/rocm.html),
  [official wheels](https://stable.repo.amd.com/rocm/core/whl-next/),
  `src/backend/install/windows-rocm-runtime.ts`, `windows-rocm-packages.ts`, `windows-rocm-wheel.ts`.
