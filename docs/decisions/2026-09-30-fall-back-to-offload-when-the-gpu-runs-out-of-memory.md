---
date: 2026-09-30
title: "Fall back to offload when the GPU runs out of memory"
---

# 2026-09-30 — Fall back to offload when the GPU runs out of memory

- **Context:** Tester feedback on an RTX 3060 (12 GB): with the image settings' "Keep on GPU" an image takes
  about two minutes and its decode about ten seconds, while "Auto" is much slower. The app picks the offload
  policy before the load (`lib/diffusion/fit.ts`): it counts the transformer, the VAE, the text encoder (on
  the GPU outside macOS) and 1.5 GiB of activations per megapixel as resident at once and keeps the model on
  the GPU only up to 70 % of VRAM. On 12 GB that sends Z-Image, Krea 2 and Wan 2.2 5B to `group` offload and
  FLUX.2 Klein and Qwen-Image 2.1 to `model` offload, which also runs the text encoder and the VAE on the CPU.
  The core ran whatever policy it was given; a load or a job that ran out of memory failed with
  `OUT_OF_MEMORY`.
- **Decision:** `LoadDiffusionModelRequest.offloadFallback` (optional) names the policy to take when the model
  runs out of memory under `offload`. The spec carries it, and `withOffloadFallback` (`session.ts`) turns a
  spec into its fallback with none left.
  - **Load:** a spawn that fails with `OUT_OF_MEMORY` is spawned once more under the fallback, after the same
    CUDA/ROCm settle wait; the load reports one `loading` → `loaded`, with the fallback's `offload`.
  - **Job:** an `OUT_OF_MEMORY` job, whether the server died or failed only the job, restarts the server
    under the fallback (state reason `offload-fallback`) and runs the job again, as the ggml-abort path does
    for the CPU backend. The session keeps the fallback until the next load; the CPU-backend retry drops it.
  - The diffusion OOM classifier also reads `ErrorOutOfDeviceMemory` (ggml-vulkan) and
    `CUDA_ERROR_OUT_OF_MEMORY`, which the chat classifier already knew; without them a Vulkan build would
    never fall back.
- **Consequences:** The app can keep a model on a discrete GPU and let the core move it off only when the
  memory actually runs out. A shortage costs a restart and, mid-job, the work done so far; a job that falls
  back is priced by its first estimate. A second shortage, under the fallback, fails as before. Without
  `offloadFallback` nothing changes. A driver that spills to system memory instead of failing (NVIDIA on
  Windows) never reports the shortage, so the job just runs slower.
- **Owner:** team.
- **Links:** `src/diffusion/{session,jobs,progress,parse,service}.ts` and their tests; app
  `web-app/src/stores/image-generation-store.ts`, `web-app/src/lib/diffusion/fit.ts`.
