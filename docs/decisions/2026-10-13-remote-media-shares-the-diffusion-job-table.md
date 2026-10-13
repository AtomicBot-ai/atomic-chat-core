---
date: 2026-10-13
title: "Remote media is a core module that shares the diffusion job table"
---

# 2026-10-13 — Remote media is a core module that shares the diffusion job table

- **Context:** Cloud providers (OpenAI, OpenRouter, xAI, Gemini, MiniMax, DashScope, AIMLAPI, Eden AI,
  Hugging Face, NVIDIA, Mistral, Meta) and self-hosted servers (Ollama, Automatic1111/Forge, a
  stable-diffusion.cpp `sd-server` — through the `a1111` adapter —, any OpenAI-compatible server) offer image and video generation, but the core served `/v1/images/generations`
  and `/v1/videos` only from the resident sd.cpp model and forwarded only chat and embeddings. The app's
  Images and Video pages, and every API client, need those providers' models too. Each provider has its
  own media API; every video API is an asynchronous job of minutes that the provider bills whether or not
  anyone waits.
- **Decision:**
  - `src/media/` holds the catalog (conf `providers/media.json`, lenient parser, bundled baseline, disk
    cache, `ATOMIC_MEDIA_CATALOG_URL` test hook), one adapter per provider media API ("dialect"), and the
    service that resolves `{provider, model}` against the registered cloud providers.
  - A generation request (`ImageGenerateRequest`, `VideoGenerateRequest`) names a provider's model with
    `target` and its provider-only settings with `remote`. Such a job is a record in the same
    `DiffusionState` table, goes out as the same `diffusion:*` events and lands in the same galleries as a
    local one (`src/diffusion/remote-job.ts`). It takes no `activeJobId`, no GPU claim and no idle timer;
    up to four run at once. Cancel aborts the job's requests and asks the provider to stop, best effort; it
    never stops `sd-server`.
  - The request that starts a generation is never retried. A submitted clip is written to
    `<data>/diffusion/remote-jobs.json` and polled again after a restart; it is never submitted twice.
  - A provider registration (`PUT /cloud/providers/:id`) carries `media {image_api?, video_api?, models}`.
    Absent keeps what is stored, `null` clears it. Media stays out of the key binding: no media URL comes
    from the catalog — every adapter derives it from the registered `base_url` in code (one exception,
    NVIDIA's hosted `ai.api.nvidia.com`, is hard-coded) — so the media list never changes where a key goes,
    and a record registered before media existed keeps its key. A file a provider points at is fetched with
    the key only on the provider's own origin, anywhere else bare and over https only.
  - Galleries keep what a provider sends: a PNG gets the recipe spliced in like a local one; a JPEG or
    WebP is kept as it came with its recipe in an `<id>.json` sidecar (no transcoding: the core has no
    codec); an MP4 sits beside the WebMs. The recipe's `engine` is `{kind:'remote', provider, api}`.
  - Media models stay out of `/v1/models` and out of chat routing (`models[]`), like the local image models.
    `/v1/images/generations` and `/v1/videos` serve an enabled remote model a client names
    (`<provider>/<model>` or the bare id); `/v1/images/edits` (JSON form) is new and serves remote models
    only. The app reads the catalog and a provider's models through `GET /atomic/v1/media/{catalog,
    providers/:p/models}`, never conf directly.
- **Consequences:** The Images and Video pages, the public API and `atc` get every provider through one
  runner, one table and one set of events, and no local job is ever blocked by a remote one. Each new
  provider API is one adapter file and a conf entry; a model that stops working is withdrawn in conf
  without a release. An older core reading a gallery with remote items treats them as foreign and never
  deletes them. Mistral's agent files and providers' temporary URLs are not cleaned up by the core.
  Several provider details are unverified (marked in each adapter's header) and are gated by the live
  tests; multipart `/v1/images/edits` is not served.
- **Owner:** `team`
- **Links:** `src/media/`, `src/diffusion/remote-job.ts`, `src/diffusion/remote-store.ts`,
  `src/server/public/{images,videos,remote-media}.ts`, `src/server/control/routes/media.ts`,
  conf `providers/media.json`.
