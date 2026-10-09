---
date: 2026-10-09
title: "Calibrate the video decode apart from the steps"
---

# 2026-10-09 — Calibrate the video decode apart from the steps

- **Context:** The RC 2.2.1 retest stopped a Wan 2.2 TI2V 5B clip (832×480, 25 frames, 1 step, one
  decode graph on Metal) after 30 minutes of "Decoding frames"; the app had forecast 18–28 minutes.
  It was not a hang: the same clip on the same 64 GB M1 Max had decoded in 2488 s and 2594 s on
  2026-09-30. Two things made the forecast wrong. (1) The table's decode, scaled by
  `METAL_DECODE_FACTOR` (10, measured on the M3 Pro–M4 Pro class, see
  `2026-09-30-keep-the-video-eta-past-its-forecast.md`), said 290 s; the M1 Max took 8.6–8.9 times
  that. (2) `historyMultiplier` applied one ratio, `total / heuristic`, to the encoders, the steps and
  the decode alike. The machine's earlier clips (22 and 30 steps) gave 4.3, blending steps that ran
  about 1.4× the table with a decode that ran about 9×, so a decode-heavy one-step clip got about half
  its real decode.
- **Decision:**
  - *M1 factor:* `METAL_DECODE_FACTOR_BY_GENERATION` sets 87 for the M1 generation (the M1 Max
    measurement); every other chip keeps 10 until it is measured.
  - *Decode time on the recipe:* the tracker notes when the last sampling step is seen; the clip's
    recipe (and its sidecar) gets an optional `decodeMs`, from that moment to the saved clip. Older
    sidecars without it, or with a malformed one, still read.
  - *Two multipliers:* `historyMultiplier` returns `{ sampling, decode }`. A clip with `decodeMs`
    gives `(durationMs − decodeMs) / (encode + steps × step)` and `decodeMs / decode`; a clip without
    it gives its total ratio for both. Each is the median, within ×0.1..×10. `estimateVideoCost`
    scales the encoders and steps by `sampling` and the decode by `decode`, so the live ETA's decode
    part moves too.
- **Consequences:** On the retest machine the same request now forecasts about 45 minutes, before any
  new clip. Elsewhere the decode calibrates itself from the first clip made with this build. Costs:
  `decodeMs` includes the WebM encode and up to one poll interval; a clip whose last step line was
  never seen records none. The decode is still one blocking graph on Metal (no `IM2COL_3D`), so it
  shows no progress and Stop still waits the 5 s grace before stopping sd-server; neither changes
  here.
- **Owner:** team
- **Links:** `src/diffusion/video-estimate.ts` (`metalDecodeFactor`, `estimateVideoCost`),
  `src/diffusion/video-history.ts` (`historyMultiplier`), `src/diffusion/tracker.ts`
  (`decodeStartedAt`), `src/diffusion/video-job.ts`, `src/diffusion/video-recipe.ts`,
  `src/contracts/diffusion.ts` (`VideoRecipe.decodeMs`).
