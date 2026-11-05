---
date: 2026-11-05
title: "Offer the upstream Linux x64 ROCm build"
---

# Offer the upstream Linux x64 ROCm build

Upstream publishes an Ubuntu x64 archive built with HIP. The core used to discard it when reading the mirror and map its installed id to CPU. The mirror must first publish and approve the asset through its ordinary release process.

Recognize ROCm 10.0 by its exact archive suffix. Check AMD hardware, the HIP runtime and that all KFD GPU targets were compiled into this upstream build. Installation runs the staged binary with `--list-devices` and requires an enumerated ROCm device before replacing a working pack. The TurboQuant target list describes a different binary. Keep the upstream VRAM policy and prefer an offered ROCm pack to Vulkan. If an installed ROCm pack enumerates no devices or the catalog lacks the pack, continue through the existing Linux selection. A different ROCm build requires checking its target matrix before adding it.

Owner: team. [Upstream build matrix and packing step](https://github.com/ggml-org/llama.cpp/blob/b11617/.github/workflows/release.yml#L1485-L1593).
