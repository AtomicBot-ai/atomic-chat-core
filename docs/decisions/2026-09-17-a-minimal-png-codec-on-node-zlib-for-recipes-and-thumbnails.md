---
date: 2026-09-17
title: "A minimal PNG codec on node:zlib for recipes and thumbnails"
---

# 2026-09-17 — A minimal PNG codec on node:zlib for recipes and thumbnails

- **Context:** The gallery keeps an image's recipe inside the PNG (`tEXt` chunks `atomic` and `parameters`, right after `IHDR`) and a 256 px thumbnail beside it. The plugin did this with three crates: `png`, `image` and `crc32fast`. The core's dependencies are frozen, native addons are not allowed in the compiled binary (which rules out `sharp`), and a pure-JS imaging package would be a new dependency to audit for a signed binary, for the sake of one downscale.
- **Decision:** `src/diffusion/png.ts`, on `node:zlib` alone. Splicing works on chunks and never touches the image data: signature, `IHDR`, our `tEXt` chunks with a table-driven CRC-32 of our own, then the rest of the file byte for byte. Listing reads a file only up to its first `IDAT` (at most 256 KiB). For thumbnails a decoder for exactly what stable-diffusion.cpp writes, checked on real outputs: 8-bit RGB or RGBA, non-interlaced, any filter type, any number of `IDAT` chunks; a box downscale to 256 px on the longest side that never upscales; an encoder with the usual minimum-sum-of-absolute-differences filter choice per row. The inflated size is known from `IHDR`, so inflation is capped at it and a dimension cap refuses absurd headers before anything is allocated. Decoding and scaling yield to the event loop between row batches. Anything else (16-bit, palette, grayscale, interlaced) gets no thumbnail: `thumbnailPath` is `null`, which the contract always allowed.
- **Consequences:** No new dependency. Only images the core itself just received from the engine are ever decoded; a foreign PNG in the output folder is read for its header and nothing more. A 2048² image costs a few hundred milliseconds of main-thread time in slices, once, at save. If a future engine writes another PNG flavour, its images simply have no thumbnails until the decoder learns it.
- **Owner:** team.
- **Links:** `src/diffusion/{png,recipe,gallery}.ts`, `test/fixtures/png/`; app source `src-tauri/plugins/tauri-plugin-atomic-diffusion/src/gallery.rs` at `767ff6350`.
