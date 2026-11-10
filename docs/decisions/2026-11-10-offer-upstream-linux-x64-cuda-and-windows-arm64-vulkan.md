---
date: 2026-11-10
title: "Offer the upstream Linux x64 CUDA and Windows arm64 Vulkan builds"
---

# 2026-11-10 — Offer the upstream Linux x64 CUDA and Windows arm64 Vulkan builds

- **Context:** ggml-org now publishes Ubuntu x64 CUDA archives (`ubuntu-cuda-12.8-x64`, `ubuntu-cuda-13.N-x64`, each with a tagged `cudart-llama-…` companion) and a Windows on Arm Vulkan zip (`win-vulkan-arm64`). The core dropped all three when it read a release: the Linux CUDA pattern matched arm64 only, and the Windows arm64 whitelist had no Vulkan entry. An NVIDIA Linux x64 host ran Vulkan at best, and a stored `ubuntu-cuda-*-x64` id mapped to CPU.
- **Decision:** Read the Linux x64 CUDA archives as `linux-cuda-<toolkit>-x64` and offer them through the minor-less families `linux-cuda-12-x64` and `linux-cuda-13-x64`, gated by the existing Linux driver floors and the CUDA 13 architecture floor. The cudart companion installs with the pack, as on arm64. On Linux x64 the ideal backend is the first of CUDA 13, then CUDA 12, that survives the `--list-devices` probe, then the existing ROCm and Vulkan order. A catalog without a Linux x64 CUDA build falls through to ROCm and Vulkan, because conf may not have published one yet. Offer `win-vulkan-arm64` whenever Vulkan is on, ranked below OpenCL as Vulkan is on x64, so a Snapdragon's Adreno keeps OpenCL.
- **Consequences:** The archives reach users only once conf mirrors and approves them. A Turing card on a pre-R616 driver may fail to load the CUDA 13 build on Linux, as it did on Windows. The Windows driver gate is not applied to Linux because there is no Linux telemetry yet. Such a failure moves the load to the next installed build and records the CUDA 13 build as bad for that driver, so the advisor then recommends CUDA 12 (ADR `2026-11-04-run-only-gpu-builds-the-card-can-run-and-retry-once.md`). Adreno reports 512 MiB of dedicated memory, so Vulkan is never the automatic pick there; it stays a manual choice and a fallback.
- **Owner:** team.
- **Links:** `src/backend/catalog/{archive,cuda-family,manifest,migrate}.ts`, `src/backend/select/{features,tiers,categories,recovery}.ts`; [upstream release workflow](https://github.com/ggml-org/llama.cpp/blob/b12244/.github/workflows/release.yml#L330-L460); ADR `2026-11-05-offer-upstream-linux-rocm.md`.
