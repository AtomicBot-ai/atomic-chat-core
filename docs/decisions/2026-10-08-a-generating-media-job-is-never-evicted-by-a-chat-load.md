---
date: 2026-10-08
title: "A generating image or video job is never evicted by a chat load"
---

# 2026-10-08 — A generating image or video job is never evicted by a chat load

- **Context:** GPU residency (spec `gpu-residency`, design D10) keeps one resident local model per card
  and is deliberately blunt: a load stops whatever else holds the card, answering or not. For sd-server
  that stop went through `DiffusionService.unloadModel`, which cancels the active job, waits 5 s for the
  engine to honour it and then kills the server. RC 2.2.0 QA lost a Wan 2.2 clip that way: while it was
  decoding frames, opening a TurboQuant chat loaded Gemma 4 E2B, the core logged "cancel not honoured
  within 5000 ms; stopping sd-server", and the Video page later said the job was cancelled although
  nobody pressed Stop (ATO-549). A chat answer cut off by a model switch costs seconds; a clip costs
  minutes to tens of minutes.
- **Decision:** An occupant may report `busy` — a sentence for the user — together with a `remedy`.
  Diffusion reports both while a job runs on its resident or starting server that nobody asked to
  cancel. Residency refuses a claim whose evictions include a busy occupant with `GPU_BUSY`
  ("Wan 2.2 TI2V 5B is generating a video; loading another model on the same GPU would cancel it.
  Wait for the video to finish, or stop it, then try again.", details `… busy=true`) before stopping
  anything, and asks again right before each stop, since a job can start while an earlier stop is
  awaited. An idle image model, chat models, and every other occupant are stopped as before.
- **Consequences:** No proxy or activity count is needed: the diffusion service already knows its
  active job. Chat waits for the media job or for the user to stop it; it no longer silently wins. The
  app shows the core's message under its own "The GPU is busy" title. A job whose cancel is already in
  flight is not busy, so an explicit Stop followed by a chat load goes through.
- **Owner:** team
- **Links:** `src/runtime/shared/gpu-occupancy.ts`, `src/core/gpu/policy.ts` (`busyHolder`,
  `gpuWorkingError`), `src/core/gpu/residency.ts`, `src/diffusion/service.ts` (`gpuOccupancy`); Linear
  ATO-549.
