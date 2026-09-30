---
date: 2026-09-30
title: "Keep the video ETA past its forecast"
---

# 2026-09-30 — Keep the video ETA past its forecast

- **Context:** Owner feedback: the time a clip takes is forecast far too low, and once the forecast is spent
  nothing is recalculated. What the core did (ADRs 2026-09-28-estimate-video-generation-before-and-during-the-job
  and 2026-09-29-report-the-tiled-decode-and-tile-it-by-memory):
  - Before the first measured step, and through a decode with no finished tile (one graph, or a tile pass whose
    first tile is still running), `etaSeconds` counted the forecast down and went `null` once it was spent. The
    app then shows no time left at all, and `fraction`, which follows the time only while the ETA is known,
    parks. A decode on Metal can run half an hour in that state.
  - The decode is the part that is off. ggml's Metal backend has no `IM2COL_3D`, so every 3-D convolution of a
    video VAE runs the direct `kernel_conv_3d`. The one decode measured, a Wan 2.2 TI2V 5B clip at 704×1280 and
    25 frames, took 250 s per 32×32-latent tile; the table's `decodeSeconds` prices that tile at 20–26 s on an
    M3 Pro to M4 Pro class Mac.
  - The live ETA scaled the decode forecast by measured/forecast step time within `[0.25, 20]`. Fast steps
    shrank a decode that is already too short, and a history multiplier raised by slow decodes was divided
    back out of the decode as soon as the steps ran at the heuristic's pace.
- **Decision:**
  - **Overrun** (`video-eta.ts`, `leftOf`): past its forecast, a stretch (the whole job before the first
    measured step; the decode without a finished tile) is forecast at twice as long, and again at twice that
    once that is spent (`OVERRUN_GROWTH = 2`). The countdown starts over instead of going `null`, and the
    fraction keeps following the time. `null` stays for no forecast, an estimate without seconds, every tile
    done, and saving.
  - **Step ratio** `STEP_RATIO_RANGE = [1, 20]`: steps slower than forecast still stretch the decode; faster
    ones leave it whole.
  - **Metal decode** (`video-estimate.ts`): `METAL_DECODE_FACTOR = 10` multiplies the decode's seconds when it
    runs on the Metal device (backend `metal`, not the CPU fallback, not under `model` offload, where the
    engine decodes on the CPU). The history multiplier is measured against the new heuristic, so past clips
    carry over.
- **Consequences:** Estimates of video clips on Macs grow by the decode's share: the feedback clip in one graph
  on a 24 GB M4 Pro now forecasts about 11.5 min of decode instead of about 1 min. A job past its forecast
  shows a time left that jumps up at each doubling rather than none; the app needs no change. The factor rests
  on one measurement of one family on an unnamed Mac; LTX-2 and the other chips are extrapolated, and history
  calibration and the ×2/×3 ranges still carry the rest. The real fix, a 3-D convolution on Metal in sd.cpp or
  our `-a` build, is not addressed. Supersedes the "`null` once spent" and `[0.25, 20]` parts of ADR
  2026-09-28-estimate-video-generation-before-and-during-the-job and the "Before the first tile, and for a
  decode in one graph, the forecast as before" part of ADR 2026-09-29-report-the-tiled-decode-and-tile-it-by-memory.
- **Owner:** team.
- **Links:** `src/diffusion/{video-eta,video-estimate}.ts` and their tests; ADRs
  2026-09-28-estimate-video-generation-before-and-during-the-job,
  2026-09-29-report-the-tiled-decode-and-tile-it-by-memory; upstream stable-diffusion.cpp #2038.
