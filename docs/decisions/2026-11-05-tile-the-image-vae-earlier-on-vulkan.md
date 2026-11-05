---
date: 2026-11-05
title: "Tile the image VAE from above 768² on Vulkan"
---

# 2026-11-05 — Tile the image VAE from above 768² on Vulkan

- **Context:** Atomic-Chat#350: on a 24 GB RX 7900 XTX (Windows, Vulkan build) FLUX.2 Klein 4B put every
  weight in VRAM, yet its 1024² decode logged `vae compute buffer size: 7435.00 MB(RAM) on CPU` and took
  35–38 s; 512² stayed on the GPU, and `sd-cli --vae-tiling` decoded 1024² in 2.66 s on `Vulkan0`. The
  offload policy was not the cause (no `--vae-on-cpu`, 0 MB of weights in RAM). ggml's Vulkan backend
  refuses an op whose tensor exceeds the device's `maxStorageBufferRange` / `maxBufferSize` (typically
  4 GiB), and the scheduler runs that op on the CPU. sd.cpp builds its conv weights in F16, so the
  FLUX-style VAE's full-resolution 3×3 convolutions over 256 channels unfold (im2col) to 4608 bytes per
  output pixel: 4.5 GiB at 1024², past the cap from about 0.93 MP. `args.ts` tiled images only past
  1024² (strict `>`), a threshold set by memory, so every family's 1024² default and the 832×1216 FLUX
  size decoded in one graph.
- **Decision:** `buildImgGenRequest` takes the tiling area; `imageVaeTilingArea(spec)` gives
  `VULKAN_VAE_TILING_AREA` (768², about 2.5 GiB for that tensor) while a Vulkan build runs on its device,
  and `VAE_TILING_AREA` (1024², unchanged) on every other backend and after the CPU fallback. A tiled
  request sends `vae_tiling_params: {enabled: true}` as before. Video keeps its own plan and threshold.
- **Consequences:** On Vulkan, images above 768² decode tiled on the GPU instead of partly on the CPU;
  768² and smaller decode in one graph as before. Tiling an image that would have fit costs a little decode
  time (seconds), far less than a CPU decode. The rule assumes the FLUX-style VAE's channel layout; a
  driver with a smaller per-buffer limit than 4 GiB, or a VAE with wider full-resolution convolutions,
  could still overflow at 768² and would show the same CPU compute-buffer line. Newer sd.cpp builds
  choose direct convolution per backend (`conv2d direct auto`), which avoids im2col where it is picked;
  tiling stays correct either way. No setting exposes tiling yet: the app's Memory = `model` forces it but
  also moves the VAE and text encoder to the CPU.
- **Owner:** team.
- **Links:** <https://github.com/AtomicBot-ai/Atomic-Chat/issues/350>; `src/diffusion/{args,image-job}.ts`
  and their tests; ggml-vulkan `ggml_backend_vk_device_supports_op` (tensor-size check); sd.cpp
  `Conv2d::init_params` (F16 weights), `auto_encoder_kl.hpp` (`ch = 128`, `ch_mult = {1, 2, 4, 4}`).
