---
date: 2026-11-06
title: "Measure AMD APU shared memory separately from VRAM"
---

# Measure AMD APU shared memory separately from VRAM

The Radeon 860M host reports 512 MiB of reserved VRAM and 15,606 MiB of GPU-accessible system memory. The upstream llama.cpp selector previously applied its 2 GiB threshold only to reserved VRAM, choosing CPU even when the APU could use the GTT pool.

The Linux probe reads `mem_info_gtt_total` only as shared capacity for an AMD device bound to amdgpu whose GC IP version is a documented APU. A discrete GPU also has GTT, so a small VRAM number alone is insufficient. Clamp the reported pool to physical RAM. Expose it as optional `shared_memory` (MiB); retain `total_memory` as dedicated/reserved VRAM for compatibility. Capacity is not current free memory or a promise that a native runtime allocation will succeed.

Stock llama.cpp's eligibility threshold uses the larger of the two measured pools, never their sum. Model-fit recognizes the APU as integrated but keeps its fully GPU-resident estimate conservative: GTT does not prove that the selected native runtime allocates all of that pool. In particular, stock HIP defaults to hipMalloc unless unified-memory allocation is explicitly enabled. Shared capacity is never added to physical system RAM. ROCm still requires the HIP runtime, supported compiled gfx targets, an available approved archive and the existing installation device probe. Missing ROCm dependencies or archives fall through to Vulkan when eligible. This change does not install system packages, publish artifacts, or modify TurboQuant selection.

The operator host has no discoverable HIP runtime. On 2026-11-06 the mirror's five indexed stock releases carry Windows ROCm archives, but no Linux ROCm archive; upstream b12019 does carry the Linux archive. The earlier blanket statement that no ROCm build existed was too broad. Runtime preparation and mirror publication are separate prerequisites, not successful results of this memory correction.

Owner: team.

Sources: [kernel APU GC table](https://github.com/torvalds/linux/blob/master/Documentation/gpu/amdgpu/apu-asic-info-table.csv), [kernel GTT reporting](https://docs.kernel.org/gpu/amdgpu/driver-misc.html), [stock mirror catalog](https://github.com/AtomicBot-ai/atomic-chat-conf/blob/main/backends/llamacpp-upstream-releases.json).
