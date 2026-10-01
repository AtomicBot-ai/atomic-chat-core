---
date: 2026-09-29
title: "Report the tiled decode and tile it by memory"
---

# 2026-09-29 — Report the tiled decode and tile it by memory

- **Context:** Users report clips sitting on "Decoding frames…" for half an hour and more (a Wan 2.2 TI2V 5B
  clip at 704×1280, 25 frames, 10 steps, 1845 s in), with no way to tell work from a hang. What the core did:
  - The tracker skipped the decode's tile pass whole. sd.cpp announces it (`processing N tiles`) and redraws its
    bar once per tile (`3/8 - 250.00s/it`); the skip kept tiles from reading as sampling steps, and threw the
    decode's only progress signal away with them.
  - The live ETA (ADR 2026-09-28-estimate-video-generation-before-and-during-the-job) counted the decode forecast
    down and went `null` once it was spent; `fraction` parked; `slowdown` watched sampling steps only.
  - The forecast is far off on Metal: ggml's Metal backend has no `IM2COL_3D`, so every 3×3×3 convolution of the
    Wan VAE runs on the direct `kernel_conv_3d` (upstream sd.cpp #2038 names that path "much slower"), while
    `decodeSeconds` is a first guess.
  - `args.ts` tiled every clip past 8 M pixel-frames in sd.cpp's default tiles (32 latent pixels, half overlap),
    whatever the machine's memory. Each tile decodes every frame and neighbours overlap, so 704×1280 on the Wan
    VAE (a 44×80 latent) is 2×4 tiles of 32×32, 2.33 times the work of one graph; the estimate priced any tiling
    at ×1.25.
- **Decision:**
  - **The decode's tiles** (`tracker.ts`): a tile pass announced while the job decodes is the decode; its
    rate-bearing redraws count as `decodeTiles {done, total}`. A second announcement (sd.cpp retrying a decode
    that failed to allocate, with finer tiling) starts the count again. A pass before sampling (an init image's
    encode) and verbose lines that carry `k/N` do not count.
  - **Wire** (additive): `VideoJobProgress.decodeTiles?: {done, total}`, present while a tiled decode runs and
    absent in every other phase, for a decode in one graph, and from older cores.
  - **ETA** (`video-eta.ts`): once a tile finished, the decode's time left is the running tile's rest plus the
    tiles after it at the pace measured from the pass's start; a tile running past the pace stretches it, as a
    step does. Zero once every tile is done, reported as `null` (the clip is being assembled and encoded). Before
    the first tile, and for a decode in one graph, the forecast as before. The fraction rule is unchanged.
  - **Slowdown**: also set when a tile runs past three medians of the finished tiles (at least two) and past
    20 s; there is no forecast per tile to hold it against. Sticky as before.
  - **Tiling by memory** (`planDecodeTiling`, pure, in `video-estimate.ts`): for each job the core picks one
    graph when the whole job then `fits` (at most 80 % of the budget); otherwise the tiling with the least work
    that fits, trying tile counts per axis from one up to as many as sd.cpp's own 32-pixel tiles make; and when
    none fits, the one with the smallest peak (the finest, sd.cpp's own layout). The plan rides on the job
    record (`JobPlan.decodeTiling`, never on the wire) into the body. No plan, so the threshold and sd.cpp's own
    tiles decide as before: under `model` offload (the engine decodes on the CPU, tiled by its `--vae-tiling`),
    without memory facts, and on the CPU fallback (the body is rebuilt without the plan, which was made for the
    device).
  - **Body**: a tiled plan is sent as tile counts, `rel_size_x/y` and `rel_size_w/h` together (each above 1 is a
    count, 1 the whole axis). sd.cpp renamed the fields and switched absolute tile sizes from latent to image
    pixels in #2059, with a new 256-pixel default (16 latent pixels on a 16× VAE, 36 tiles for the clip above);
    counts mean the same in both, and a build ignores the spelling it does not read. One graph sends no
    `vae_tiling_params`.
  - **Estimate**: the decode is priced with the layout the engine will run (`video-tiling.ts` ports
    `sd_tiling_calc_tiles`): peak = one tile's graph over every frame at 250 B per pixel-frame plus the clip at
    12 B; time = `c · pixelFrames · work`, `work` = the tiles' area over the latent's (replacing ×1.25).
    `VideoFamilyProfile.vaeTile` becomes `vaeScale` (LTX-2 32, Wan 2.2 16). History re-plans every past clip at
    its own size, since the recipe does not record the tiling.
- **Consequences:** The clip above decodes in one graph on a Mac with 24 GB or more (2.33 times less decode work
  than before), in three full-width strips on 18 GB (×1.5), and as before on 16 GB. The app shows a countdown
  through a tiled decode once a tile finished without any change of its own; showing "tile k/N" needs it to read
  `decodeTiles`. A decode in one graph prints no tiles, so its time left is still the forecast's and a stall in it
  is not detected. The single-graph peak rests on the Wan VAE's measured 250 B per pixel-frame; the LTX-2 VAE's is
  unmeasured. A decode that fails to allocate is retried by sd.cpp with temporal tiling, which costs the failed
  attempt and shows as a new pass. Clips made before this change ran on the threshold; history takes them as
  planned, so the multiplier reads them as slower than they were until newer clips replace them (at most five).
  The slowness of the decode on Metal is the engine's direct `conv_3d` and is not addressed here.
- **Owner:** team.
- **Links:** `src/diffusion/{tracker,video-eta,video-tiling,video-estimate,video-history,video-job,job-kind,jobs,args,service}.ts`,
  `src/contracts/diffusion.ts`, `test/e2e/video.test.ts`, `test/helpers/fake-sd-server.mjs` (`FAKE_SD_DECODE_TILES`,
  `FAKE_SD_TILE_MS`, `FAKE_SD_BODY_FILE`); ADR 2026-09-28-estimate-video-generation-before-and-during-the-job;
  upstream stable-diffusion.cpp #2038 (one-frame Wan VAE convolutions as 2D), #2059 (VAE tile sizes in image
  pixels), `src/runtime/tiling.cpp` `sd_tiling_calc_tiles`.
