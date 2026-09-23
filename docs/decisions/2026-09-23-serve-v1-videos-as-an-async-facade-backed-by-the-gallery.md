---
date: 2026-09-23
title: "Serve /v1/videos as an asynchronous facade backed by the gallery"
---

# 2026-09-23 — Serve /v1/videos as an asynchronous facade backed by the gallery

- **Context:** the images facade answers `POST /v1/images/generations` synchronously with the bytes, which is the
  OpenAI shape and fits a picture that takes seconds. A clip takes minutes, and the OpenAI Videos API is asynchronous:
  create, poll, download, delete, list. The app's ADR of 2026-09-10 on the images facade noted that a video endpoint
  would need job persistence.
- **Decision:** `/v1/videos` follows the OpenAI Videos API on the public listener and is served by the core itself,
  never forwarded: `POST /videos` queues a clip and answers its video object at once (`seconds` snapped to the nearest
  frame count on the family's lattice and clamped to its range, `size` and the rest bound to the loaded family),
  `GET /videos/{id}` polls, `GET /videos/{id}/content` streams the WebM (`variant=thumbnail` the poster), `DELETE`
  cancels a running clip or removes a finished one, `GET /videos` lists running jobs before the gallery with a cursor.
  There is no job table: a running job is the runner's record and a finished clip is its gallery item, so a finished
  video outlives a restart of the core and a failed one is forgotten with the process. The resident video model is the
  only model; an image model or nothing loaded is 503 `model_not_loaded`; the request is reported as
  `atomic-diffusion` on `videos`, and the `GET` polls and downloads are not reported. The video object carries the
  core's own facts under `atomic` (`job_id`, `seed`, `path`, `poster_path`), like the images answer does.
- **Consequences:** clients can drive the Video page's own runner from a script; a clip started from the page is
  visible to `GET /videos` and a facade clip to the page's gallery. The listing scans the newest thousand clips of the
  gallery, enough for a client that pages. `input_reference` is refused until image-to-video lands. The OpenAPI entry
  for `/videos` is added in the app's static document first (its bytes are pinned here by a contract fixture) and
  imported afterwards.
- **Owner:** team.
- **Links:** `src/server/public/{videos,videos-params}.ts`; stage 9e in `PLAN.md`;
  [2026-09-18 — Serve /v1/images/generations locally from the job runner](2026-09-18-serve-images-generations-locally-from-the-job-runner.md);
  app ADR `2026-09-10-serve-openai-images-generations-from-the-local-api-server.md`.
