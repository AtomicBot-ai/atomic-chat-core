---
date: 2026-09-28
title: "Estimate video generation before and during the job"
---

# 2026-09-28 — Estimate video generation before and during the job

- **Context:** A clip was started blind. Telemetry has a Wan 2.2 TI2V 5B run on an 18 GB Mac (704×1280, 73
  frames, 15 steps) cancelled after 21 060 s and a 16 GB laptop that waited about 12 000 s, both swapping. The
  job reported `Step i/N` and elapsed time only; `etaSeconds` covered sampling alone, froze while a step took
  minutes, and `fraction` sat at 0.97–0.98 through the whole VAE decode. The runner emitted progress only when a
  step or phase changed. Only the app estimated memory (`fit.ts`: weights + 1.5 GiB per megapixel, no frames).
  Three `video_generate` events in 30 days are too few to calibrate from, so the owner chose a heuristic in code.
  OpenSpec change `add-video-generation-estimate`.
- **Decision:** The core estimates a video request against the loaded model and its own hardware facts, and
  reports the whole job live.
  - **Estimate** (`src/diffusion/video-estimate.ts`, pure): `VideoEstimate { memory {requiredBytes,
    budgetBytes, pool, verdict}, seconds {low, high} | null, basis }` from `POST
    /atomic/v1/diffusion/video/estimate` (the job body; the job's own refusals; nothing starts, it answers while a
    job runs) and on `VideoJob.estimate` from the first `diffusion:video-job`. A failed estimate costs the job
    only its estimate.
  - **Memory:** the weights are every file of the spec (`stat` once at load, kept across respawns, cleared at
    unload). Sampling activations are `latentTokens × bytesPerToken[family]` with `latentTokens = ⌈W/sx⌉·⌈H/sy⌉·(1
    + (frames−1)/st)` (LTX-2 32/32/8, Wan 2.2 32/32/4). The VAE decode peak is `pixelFrames × 250 B` (the 27.6 GB
    measured on 2026-09-23); tiled (past `VIDEO_VAE_TILING_PIXEL_FRAMES` or under `model` offload) one tile's
    graph over every frame plus the decoded clip at 12 B per pixel-frame. Pools: `unified` on Metal under macOS
    (`total × 0.85`), `system` for the CPU backend, the CPU fallback or no discrete GPU (`total − RESERVE_BYTES`),
    `vram` otherwise with both sides checked and the worse one reported. The offload policy decides what sits
    where: `none` puts everything on the device; `group` keeps the weights in RAM and copies the running model to
    the device, so on unified memory the running model counts twice; `model` also decodes on the CPU. Plus 1 GiB
    of overhead. `fits` ≤ 80 %, `tight` ≤ 100 %, `exceeds` past it, and then `seconds: null`.
  - **Time:** `t_encode + steps × t_step + t_decode`; `t_step = passes × (a·L + b·L²) / speed + 0.3 s` (two
    passes under CFG > 1; the fixed 0.3 s keeps a tiny request's step from being forecast in milliseconds, which
    tripped the slowdown rule on the fake engine), `t_decode = c · pixelFrames / speed` (×1.25 tiled). `speed`
    is relative to a 40-core M3 Max: Apple Silicon by chip name (the lower GPU bin; M5 extrapolated), discrete
    GPUs by VRAM class × a backend factor (ROCm 0.7, Vulkan 0.6), the CPU backend at 0.006 per core; unknown
    hardware takes the bottom row of its class. The range is `[mid/2, mid×2]`, `[mid/3, mid×3]` on unknown
    hardware or an unknown family.
  - **History** (`video-history.ts`): up to five newest clips of the same family, backend and offload, not on
    the CPU fallback and not `exceeds` at their own parameters; `k = median(actual / heuristic)` within
    `[0.1, 10]`; the middle becomes `mid × k`, the range `[×0.8, ×1.25]`, `basis: 'history'`. The recipe list is
    cached and dropped when a clip is saved or deleted.
  - **Live progress** (`video-eta.ts`, one per job across CPU-fallback attempts): `etaSeconds` now means **the
    whole job** (a semantic change of the wire contract): before two step marks the estimate's middle less the
    elapsed time (`null` without seconds); then the remaining steps at the measured pace (a step running past
    the pace stretches it) plus the decode forecast scaled by measured/forecast step time in `[0.25, 20]`;
    counting down through decoding and `null` once spent; `null` while saving. `fraction = elapsed / (elapsed +
    eta)` when the ETA is known, the phase value otherwise, never decreasing, at most 0.99. `elapsedMs` counts
    from the runner's start. `slowdown` (always sent) turns on when a step runs past three medians of the
    completed steps and past 20 s (at least two completed), or past three times the forecast's top for a step,
    and stays on. The runner emits a clip's progress on every change and, while it generates, whenever waiting
    for the next poll would leave the last emit older than 1 s (`JobKind.heartbeatMs`); images are unchanged.
  - The tracker also ends a lost tile pass on `generating video:`.
- **Consequences:** Every host of the core gets the same estimate; the app shows it and asks before an
  `exceeds` run (app ADR). Old apps ignore the new fields and see more frequent events of the same type; new
  apps on an old core get a 404 from the estimate route and hide the line. The coefficients (`a, b, c,
  t_encode`, bytes per token, `BYTES_PER_PIXEL_FRAME`, the speed table) are first guesses from FLOP counts at
  about 5 effective TFLOPS on the reference; **they are not yet measured**. The live measurement (Wan 2.2 and
  LTX-2 on a 16–24 GB Mac, a ≥ 36 GB Mac and a CUDA machine, `ATOMIC_LIVE=1`) and the corrected coefficients
  go into a follow-up record; until then history calibration and the ×2/×3 ranges carry the error. The verdict
  reads total memory, not free memory: a browser or a chat model in RAM is what the 80 % line is for. A clip
  that ran on the CPU fallback may raise `slowdown` against a GPU forecast.
- **Owner:** team.
- **Links:** `src/diffusion/{video-estimate,video-history,video-eta,video-job,jobs,session,service,tracker}.ts`,
  `src/contracts/diffusion.ts`, `src/server/control/routes/diffusion-video.ts`, `src/client/control-client.ts`,
  `test/e2e/video.test.ts`, `test/helpers/fake-sd-server.mjs` (`FAKE_SD_SLOW_AFTER`); ADR
  2026-09-23-generate-video-through-the-resident-diffusion-session; app ADR 2026-09-27 (the core is the only
  source of hardware facts); OpenSpec `add-video-generation-estimate` in `atomic-chat-spec`.
