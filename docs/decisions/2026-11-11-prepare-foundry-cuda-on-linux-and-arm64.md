---
date: 2026-11-11
title: "Prepare Foundry CUDA on Linux and ARM64"
---

# 2026-11-11 — Prepare Foundry CUDA on Linux and ARM64

Foundry Local 2.4.0 exposes Microsoft CUDA providers for Windows and Linux on
x64 and ARM64. The x64 providers require CUDA 12. The ARM64 providers require
CUDA 13. Both use cuDNN 9. Native model hosts need the matching libraries before
registering the provider.

The existing CUDA prepare and cache lifecycle now selects a pinned archive set
by the active Foundry build and its platform. Windows ARM64 uses NVIDIA CUDA
13.4 Update 2 and the matching cuDNN 9.25 ZIPs. Linux x64 uses the NVIDIA CUDA
12 and cuDNN 9.20 wheels previously qualified on Ubuntu. Linux ARM64 uses the
CUDA 13.4 and cuDNN 9.25 ARM64 wheels. Wheels are ZIP archives with the runtime
SONAME files already materialized, so core can use its existing streaming ZIP
reader and leave each ELF library under its required loader name. Each archive
has a pinned URL, size, SHA-256, an exact member allowlist and a license notice.

Only the explicit Prepare CUDA flow downloads the archives. The Windows child
uses its private cache through `PATH`, with x64 also using `AddDllDirectory`.
The Linux child gets its cache at the front of `LD_LIBRARY_PATH` before spawn.
The NVIDIA driver remains a system dependency. Windows x64 keeps the existing
cache revision, and macOS continues to use WebGPU.

Linux ARM64 CUDA model checks and loads require Foundry 2.4.0 or newer and use
its actual provider discovery and preparation record. Managed preparation is
pinned to the 2.4.0 release on all four targets.

- [Foundry Local 2.4.0 release notes](https://github.com/microsoft/Foundry-Local/releases/tag/v2.4.0)
- [NVIDIA CUDA 13.4 Update 2 redistribution manifest](https://developer.download.nvidia.com/compute/cuda/redist/redistrib_13.4.2.json)
- [NVIDIA cuDNN 9.25 redistribution manifest](https://developer.download.nvidia.com/compute/cudnn/redist/redistrib_9.25.1.json)
- [NVIDIA cuDNN 9.25 package metadata](https://pypi.org/project/nvidia-cudnn-cu13/9.25.1.1/)
