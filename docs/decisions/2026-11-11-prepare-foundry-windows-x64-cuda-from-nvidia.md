---
date: 2026-11-11
title: "Prepare Foundry Windows x64 CUDA from NVIDIA"
---

# 2026-11-11 — Prepare Foundry Windows x64 CUDA from NVIDIA

The Foundry Local 2.4.0 Microsoft CUDA provider expects the CUDA 12 and cuDNN 9
runtime libraries to be available on Windows x64. Windows can discover the
provider with just an NVIDIA driver and then fail registration with error 126.

On explicit CUDA preparation for that build and platform, core downloads the
NVIDIA redistribution archives for CUDA Runtime 12.8.90, cuBLAS 12.8.4.1 and
cuDNN 9.20.0.48 for CUDA 12. Core pins the archive URLs, sizes and SHA-256 hashes
from NVIDIA's release manifests. It verifies the archives before streaming the
allowlisted runtime DLLs and NVIDIA notices into a private staging directory,
then publishes the complete set by rename. The download is about 1.2 GB and the
resulting cache is about 1.7 GB. The CUDA provider continues to come from
Microsoft, and the NVIDIA GPU driver comes from the machine.

The prepare host and later CUDA model hosts receive the cache directory through
child `PATH`. The Windows host passes it to `AddDllDirectory`. Model hosts
reuse the installed files locally. Core checks that the CUDA provider is offered
before starting an NVIDIA download. When multiple providers are requested, core
prepares the other providers before it downloads the CUDA runtime and reports
CUDA failures through the existing preparation result.

The same staging lifecycle can support additional platform and architecture
pins once their exact native dependencies and an actual CUDA inference have
been verified. Linux needs its `LD_LIBRARY_PATH` configured before host launch.
Microsoft specifies CUDA 13 with cuDNN 9 on ARM64.

- [Foundry Local 2.4.0 release notes](https://github.com/microsoft/Foundry-Local/releases/tag/v2.4.0)
- [CUDA 12.8 Update 1 redistribution manifest](https://developer.download.nvidia.com/compute/cuda/redist/redistrib_12.8.1.json)
- [cuDNN 9.20 redistribution manifest](https://developer.download.nvidia.com/compute/cudnn/redist/redistrib_9.20.0.json)
