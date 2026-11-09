---
date: 2026-11-07
title: "Cover the Radeon architectures shipped by Windows llama.cpp"
---

# 2026-11-07 — Cover the Radeon architectures shipped by Windows llama.cpp

- **Context:** The Windows ROCm PCI table was copied from the desktop generator, which matched
  marketing names against an older HIP SDK certification page. It covered 22 PCI IDs but omitted
  Ryzen AI APUs and RDNA 1/2 hardware, although llama.cpp b12019 ships their kernels. A Radeon 860M
  (1002:1114, gfx1152, Windows driver 32.0.31044.1004) was therefore offered only Vulkan.
- **Decision:** Map all known GPU PCI IDs for the 20 gfx targets in the b12019 `windows-rocm` build:
  gfx1010–1012, gfx1030–1036, gfx1100–1103, gfx1150–1153 and gfx1200–1201. Match exact silicon names
  from pci.ids against LLVM/AMD/Mesa architecture mappings, exclude non-GPU functions and unshipped
  silicon, and keep unknown devices on Vulkan. The reviewed table contains 67 PCI IDs. This is
  eligibility for the published binary, not certification of every driver/board combination.
  An installed Windows HIP pack must enumerate a `ROCmN` device, as Linux HIP packs already must;
  an empty result, another backend's device or a probe error rejects that tier and permits Vulkan.
- **Consequences:** Radeon RX 5000–9000 and matching workstation/APU variants can reach ROCm
  automatically. No Linux selection rule, driver installation, or global environment is changed.
  The table is a reviewed snapshot, not future proof: refresh the PCI list and shipped targets
  together. Hardware inference evidence applies only to the tested 860M, not every listed GPU.
- **Validation:** Targeted TDD reproduced missing architecture eligibility and Windows HIP probes
  incorrectly treated as usable. The 38 related cases passed, plus the Navi 22 suffix regression found during review; no aggregate verify or full
  suite ran. On Windows, b12019 installed successfully but its HIP DLL initially failed to load
  (Win32 error 126): `hipblas.dll` is an unbundled dependency. `--list-devices` returned `(none)`.
  This is independent of PCI detection and requires ROCm libraries beside/on the process path.
  With official `rocm_sdk_libraries` and `rocm_sdk_device_gfx1152` 10.0.0 wheels unpacked into an
  isolated directory and only the diagnostic process PATH changed, the same pack enumerated
  `ROCm0: AMD Radeon(TM) 860M Graphics` (12470 MiB), loaded Qwen3 0.6B Q4_K_M, and offloaded 29/29
  layers to ROCm0. Generation completed. The arithmetic smoke assertion failed (answer `2`, expected
  `4`); an identical Vulkan control also answered `2`, so this is not evidence of a ROCm-specific
  output regression. It is GPU execution evidence, not a model-quality or performance benchmark.
  Automatic delivery of the extra runtime is not implemented by this table change. The pre-test
  Vulkan activation is restored; no system PATH, driver or global SDK installation is changed.
- **Owner:** team.
- **Links:**
  - [llama.cpp b12019 Windows GPU targets](https://github.com/ggml-org/llama.cpp/blob/b12019/.github/workflows/release.yml)
  - [PCI IDs](https://pci-ids.ucw.cz/v2.2/pci.ids)
  - [LLVM targets](https://llvm.org/docs/AMDGPUUsage.html#processors)
  - [AMD GPU specifications](https://rocm.docs.amd.com/en/docs-10.1.0/reference/gpu-specs.html)
  - [ROCm Windows support](https://github.com/ROCm/TheRock/blob/main/SUPPORTED_GPUS.md)
  - [Mesa family mapping](https://gitlab.freedesktop.org/mesa/mesa/-/blob/main/src/amd/common/amd_family.c)
  - [llama.cpp Windows ROCm runtime requirements](https://github.com/ggml-org/llama.cpp/discussions/27047)
