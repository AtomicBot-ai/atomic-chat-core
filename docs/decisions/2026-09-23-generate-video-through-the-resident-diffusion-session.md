---
date: 2026-09-23
title: "Generate video through the resident diffusion session, with its own wire types and files"
---

# 2026-09-23 — Generate video through the resident diffusion session, with its own wire types and files

- **Context:** the app gets a Video page modelled on Unsloth Studio's (LTX-2.3 distilled and Wan 2.2 TI2V 5B), and the
  core is the app's only desktop backend. The engine the Images page already installs, stable-diffusion.cpp's `sd-server`
  at build 883 or newer, serves video through its asynchronous `POST /sdcpp/v1/vid_gen` (LTX-2.3/2.5, Wan 2.1/2.2; VP8 in
  WebM, animated WebP or MJPEG AVI; `supported_modes` inferred from the loaded model). Unsloth runs video on Python and
  diffusers; its load-time tuning (torch.compile, torchao quantisation, attention backends, first-block cache) has no
  counterpart on sd.cpp except the memory policy the core already maps to offload flags. The image path is a pinned
  port of the app's Rust plugin with strict parsers and tight coverage floors.
- **Decision:** one `DiffusionService`, one resident `sd-server`, one model at a time; the loaded model's `modality`
  decides which generate path is allowed, and the engine's `supported_modes` has the last word at load (a model whose
  catalog entry says `video` but whose file serves `img_gen` only is killed before it is declared loaded;
  `MODEL_INCOMPATIBLE`, answered as a 400). Video gets its own wire types (`VideoGenerateRequest`, `VideoJob`,
  `VideoJobProgress`, `VideoRecipe`, `GalleryVideoItem`, `VideoCapabilities`), its own control routes
  (`/atomic/v1/diffusion/video/*`) and its own two events (`diffusion:video-progress`, `diffusion:video-job`), while
  `diffusion:state` and `diffusion:error` are shared; nothing image-shaped changes. Inside, the runner in `jobs.ts` is
  generic over a `JobKind` (what a job validates, sends, decodes and saves), so the poll loop, the crash handling, the
  GPU-fault retirement, the CPU fallback and the cancel ladder are one code path for both. A clip is written as
  `<videoOutputDir>/<jobId>.webm` with `<jobId>.json` beside it (the recipe, every key, `null`s, as strict on the way back
  as the PNG recipe; WebM has no text chunk), a `<jobId>.thumb.png` poster the app renders from the first frame and
  uploads (`PUT …/video/gallery/:id/poster {png}`), and the same `.flags.json` in its own folder, `<data>/videos/` by
  default (the folder the app's ADR of 2026-09-10 reserved), overridable through `DiffusionConfig.videoOutputDir`. A
  `.webm` without a parseable sidecar is foreign: never listed, never deleted. The core has no video decoder (rule 8 of
  `AGENTS.md`): it checks the EBML magic and the `DocType`, and takes the engine's `frame_count` on trust, recording it
  next to the requested `frames`. The catalog carries everything family-specific (`defaults.video` with the frame lattice
  and the resolution presets, `ranges.frames`, `defaults.sigmas` for a distilled model's fixed schedule, the LTX side files
  `audioVae` and `embeddingsConnectors`); the core validates and echoes. `-M vid_gen` is emitted only behind
  `ATOMIC_DIFFUSION_VID_GEN_MODE_FLAG` until the live test says whether `sd-server` wants it. Text-to-video only: the
  wire already carries `initImage`/`endImage` and the `image-to-video` workflow id, refused until it lands.
- **Consequences:** the app mirrors the video types beside its image ones and gets two more events to relay 1:1; the
  Images page must read image capabilities only when the loaded model is an image model (the core now refuses them on a
  video model, and the other way round). The engine's own normalisation of the frame count (largest 4n+1) is visible
  as `frameCount` versus `frames`. Audio, which LTX-2 generates, is whatever the engine muxes into the WebM; the core
  records nothing about it. A generation body holds the whole base64 clip in memory, as the image path does.
  Open until the live run on a real engine: the mode flag, whether the engine lists `webm` in
  `output_formats_by_mode.vid_gen`, the exact sampling bar `vid_gen` prints, and how long the decode tail is.
- **Owner:** team.
- **Links:** stage 9a–9f in `PLAN.md`; `src/diffusion/{job-kind,image-job,video-job,video-gallery,video-recipe}.ts`;
  `src/contracts/diffusion.ts`; `src/server/control/routes/diffusion-video.ts`; app ADRs
  `2026-09-10-store-generated-media-under-the-data-folder-with-recipes-in-png-chunks.md` and
  `2026-09-10-generate-images-locally-with-stable-diffusion-cpp-in-its-own-plugin.md`;
  [2026-09-17 — Image generation is its own module](2026-09-17-image-generation-is-its-own-module-not-a-local-runtime.md).
