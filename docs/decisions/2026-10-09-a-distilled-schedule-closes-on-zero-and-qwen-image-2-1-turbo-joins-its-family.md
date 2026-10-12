---
date: 2026-10-09
title: "A distilled schedule closes on 0, and Qwen Image 2.1 Turbo runs as Qwen Image 2.1"
---

# 2026-10-09 — A distilled schedule closes on 0, and Qwen Image 2.1 Turbo runs as Qwen Image 2.1

- **Context:** Qwen released Qwen-Image-2.1-Turbo on 2026-10-09: the same 7B architecture, text
  encoder (Qwen3-VL-8B + projector) and VAE as Qwen Image 2.1, distilled to 8 steps at CFG 1 on a
  fixed schedule (`sample_sigmas` in its `model_index.json`, 8 values). The catalog already carries a
  distilled schedule as `defaults.sigmas`, one value per step, and the core sent it as
  `custom_sigmas` only in the `vid_gen` body (LTX-2), verbatim. sd.cpp runs
  `custom_sigmas.length - 1` steps (`GenerationRequest` in `src/pipeline/request.cpp`, build 883), so
  8 values ran 7 steps and stopped at the last listed sigma (0.421875 for LTX-2) instead of 0: the
  output kept that much noise. The app's catalog registry refuses a sigma of 0, so the catalog cannot
  carry the closing value itself.
- **Decision:**
  - *Schedule:* the catalog keeps one sigma per step. When a request's `steps` equals that length,
    `buildImgGenRequest` and `buildVidGenRequest` both send `custom_sigmas` with a 0 appended; any
    other step count leaves the schedule to sd.cpp, as before.
  - *Family:* `qwen-image-2.1-turbo` is a family of its own in the catalog (its defaults differ),
    and `isQwenImage21` makes it behave as `qwen-image-2.1` everywhere the core branches on that
    family: workflows `create` / `reference` / `edit`, reference workflows only with `llmVision`,
    and the engine floor of build 883.
- **Consequences:** LTX-2 distilled clips now run all eight steps and end clean; the step count
  sd.cpp prints matches the request, so progress and ETA see the real total. Turbo needs no engine
  change beyond build 883, but it was not run on a real engine before this record; the live suite
  covers it with `ATOMIC_LIVE_SD_FAMILY=qwen-image-2.1-turbo`. The app must learn the family id too:
  its registry drops a family it does not know.
- **Owner:** team
- **Links:** `src/diffusion/args.ts` (`customSigmas`), `src/diffusion/workflow.ts` (`isQwenImage21`),
  `src/diffusion/compat.ts`, `src/diffusion/validate.ts`;
  https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo;
  [Video generation through the resident diffusion session](2026-09-23-generate-video-through-the-resident-diffusion-session.md),
  app ADR `2026-09-21-gate-qwen-image-2-1-on-installed-engine.md`.
