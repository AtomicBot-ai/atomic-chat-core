---
date: 2026-10-08
title: "Malformed or undecodable embedding media is a 400 that names the field"
---

# 2026-10-08 — Malformed or undecodable embedding media is a 400 that names the field

- **Context:** `/v1/embeddings` for the embedding module passed the engine's answer through unchanged
  (ADR 2026-10-07-embedding-models-are-their-own-core-module). llama-server (b11463) answers bad inline
  media with a 500 `server_error`: `"Failed to load image or audio file"` when the bytes are no image, audio
  or video it decodes, `"Invalid base64 value"` when bare base64 decodes to nothing. Its base64 decoder
  stops at the first character outside the standard alphabet, so a placeholder (`data:image/png;base64,...`,
  which the app's own API page copied), a line break or URL-safe base64 reaches the decoder as an empty or
  cut file and comes back as the same 500 (ATO-545). A client could not tell its input from a server fault,
  and no answer said which field was wrong.
- **Decision:** Both ends of that path become 400 `invalid_request_error` / `invalid_value` with `param`,
  the OpenAI envelope's field path (`input[0].content[0].image_url.url`):
  - *Before the engine* (`checkEmbeddingRequest`): the string llama-server reads each media part from
    (`image_url.url`; `data`, else `url`, of `input_audio` and the video parts; every
    `multimodal_data[k]`) must be there, be a `data:` URL it parses (one comma, `image/` / `audio/` /
    `video/`, `;base64`) or bare base64 for a content part, bare base64 for `multimodal_data`, and hold
    standard base64 with no placeholder, whitespace, URL-safe or stray characters and no leftover single
    character. The message names the character and its position.
  - *After the engine:* its 500 with one of those two messages, for a request that carried media, is answered
    400 by `undecodableMediaVerdict`, naming the field when there is one media field and listing them
    otherwise, with the formats the running model reads (PNG, JPEG, GIF, BMP, WebP with ffmpeg; WAV, MP3,
    FLAC). Every other upstream 500 is relayed as before, read whole instead of streamed.
  - `structuredErrorJson` takes an optional `param`; existing callers' bodies do not change. The
    `dimensions` refusal now says the reduction is the client's (keep the first values, L2-normalize).
- **Consequences:** Clients get a 4xx for their own input and the field to fix; 500 stays for engine
  faults. The magic bytes are not sniffed in the core (TGA has none, video is whatever ffmpeg reads): the
  engine stays the judge of what decodes, and its wording is matched, so a llama.cpp that rewords those two
  errors falls back to relaying its 500. Verified live against b11463 with EmbeddingGemma 2 + mmproj
  (`test/live/embedding-upstream.test.ts`).
- **Owner:** team
- **Links:** `src/embedding/request.ts`, `src/server/public/embedding.ts`, `src/server/public/errors.ts`;
  llama.cpp `tools/server/server-common.cpp` (`handle_media`, `process_mtmd_prompt`); Linear ATO-545.
