---
date: 2026-10-22
title: "Leave the knobs a provider was not sent out of its recipe"
---

# 2026-10-22 — Leave the knobs a provider was not sent out of its recipe

- **Context:** A provider's media model is sent only the knobs it takes (`imageGenerationJob`,
  `videoGenerationJob`, `seedFor`). The recipe still wrote every one: a remote image recorded
  `steps` and `cfgScale` 0 and `seed`/`batchSeed` -1 when they were not sent, and a remote clip
  recorded the request's `steps` and `cfgScale` (never sent) and seed -1. Placeholders read as
  settings: app 2.2.23's Details showed "Steps 0, CFG 0, Seed -1" for a Nano Banana 2.1 picture from
  OpenRouter (app QA finding 13), the A1111 `parameters` line said the same, and Restore put them
  back into the form.
- **Decision:** `steps`, `cfgScale`, `seed` and `batchSeed` (`VideoRecipe`: `steps`, `cfgScale`,
  `seed`) are optional in the contract. A remote image recipe has a knob only when its model was
  sent it; a remote clip has no steps or CFG, and a seed only when its model takes one. A local
  recipe always has all of them, as before. `parseRecipe` / `parseVideoRecipe` accept a knob's key
  absent in a remote recipe only, so a local file without one is still not ours; a remote recipe
  written before keeps its values and still parses. `serializeRecipe` / `serializeVideoRecipe` leave
  an absent knob out (the other keys keep their order), `a1111Parameters` drops its field, and
  `/v1/videos`' `atomic.seed` is `null` for a clip without a seed.
- **Consequences:** Additive for a reader that treats the fields as optional; a client that reads
  `recipe.steps` of a remote item as a number gets `undefined`. The app reads absent knobs as not
  provided (Details, Restore, the export name) and keeps reading the old placeholders of a remote
  recipe by engine kind (app ADR 2026-10-22-show-only-the-generation-settings-a-recipe-can-vouch-for).
  Old files are not rewritten.
- **Owner:** team
- **Links:** `src/contracts/diffusion.ts`, `src/diffusion/{remote-job,recipe,video-recipe}.ts`,
  `src/server/public/videos-params.ts`, `docs/contracts.md` (remote media row), ADR
  2026-10-13-remote-media-shares-the-diffusion-job-table.
