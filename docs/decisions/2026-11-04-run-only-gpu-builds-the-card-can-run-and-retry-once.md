---
date: 2026-11-04
title: "Run only GPU builds the card can run, and retry a failed GPU load once on the next build"
---

# 2026-11-04 — Run only GPU builds the card can run, and retry a failed GPU load once on the next build

- **Context:** llama.cpp crashed on 4.5% of Windows model loads against 1.85% on macOS (PostHog, 14 days to
  2026-11-04). The largest single cause: on Turing cards (compute capability 7.5) the CUDA 13.3/13.4 builds die
  with "the provided PTX was compiled with an unsupported toolchain" in `ggml_cuda_kernel_can_use_pdl` —
  drivers 581–597: 45 users crashed and 12 loaded; 610: 46 crashed and 30 loaded; 616 and later: no crash in
  128 users, and CUDA 12.4 loads on the same cards. The CUDA 13 gate admitted CC ≥ 7.5 with any driver from
  581.15. Every such crash, and Windows loader exits with no output (0xC0000135, 0xC000007B, 0xC0000142,
  0xC000001D), read `LLAMA_CPP_PROCESS_ERROR`, with nothing for the app to report and no way out but changing
  the backend by hand.
- **Decision:** On Windows a card below CC 8.0 gets CUDA 13 builds only with driver ≥ 616.00 (upstream, PrismML,
  TurboQuant, and sd.cpp through the shared gate); otherwise CUDA 12.4, Vulkan, CPU. The PTX/no-kernel-image
  stderr is `GPU_BACKEND_INCOMPATIBLE` (OOM still wins); loader exit codes are `ENGINE_BINARY_BROKEN`, an
  illegal instruction `CPU_INSTRUCTION_UNSUPPORTED`. On those failures, or an empty-stderr crash of a GPU build,
  the load is retried once on the next installed build (CUDA 13 → CUDA 12 / ROCm → Vulkan → CPU) and the build
  is recorded in `<data>/atomic-core/bad-backends.json`, keyed by provider, backend directory and GPU driver
  (a `GPU_BACKEND_INCOMPATIBLE` record lasts until the driver changes; one whose cause can go away by itself —
  a quarantined DLL, a missing VC++ runtime, an empty-stderr crash — lapses after 7 days);
  selection and the advisor's catalog skip recorded builds, and a driver update changes the key. Every
  llama.cpp load failure ends its `details` with one `atomic-core-diag {json}` line (exit code, stage, backend,
  build, fallback, empty stderr) for the app's telemetry. A `--device` the build does not list is dropped, and a
  model's own `fit_ctx` wins over the provider's, with the fitted `--ctx-size` ceiling never below it.
- **Consequences:** A Turing user on an old driver loads on CUDA 12.4 (or CPU when nothing else is installed)
  instead of crashing; the advisor stops offering the failed build until the driver changes. A fallback to CPU
  is slow but answers. The app's Rust backend-select fixture for Turing at CUDA 13 is now a known divergence.
  Not verified on a Windows machine at the time of writing.
- **Owner:** `team`
- **Links:** `src/backend/select/features.ts` (`gpuMeetsCuda13DriverForArch`), `src/backend/select/bad-backends.ts`,
  `src/backend/install/runtime-backend.ts` (`llamaBackendFallback`), `src/runtime/llamacpp/{errors,load-failure,runtime,devices,args}.ts`,
  `src/contracts/load-diag.ts`, `src/backend/advisor/advisor.ts`.
