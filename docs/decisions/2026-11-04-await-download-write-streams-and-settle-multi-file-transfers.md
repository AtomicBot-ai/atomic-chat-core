---
date: 2026-11-04
title: "Await download write streams and settle multi-file transfers"
---

# 2026-11-04 — Await download write streams and settle multi-file transfers

- **Context:** staged engine installs such as `sd-cpp` on `win-cuda12-x64` download multiple archives in parallel into a temporary `.incoming-<stamp>.download` directory and delete that directory as soon as `Downloader.download` rejects. `Downloader.run` previously used `Promise.all` without aborting or awaiting sibling transfers on failure, and `Downloader.downloadOne` created `fs.WriteStream` instances without an `'error'` listener, without awaiting `'open'`, and without closing the stream when an abort or failure interrupted `reader.read()`. If a sibling transfer was still opening its `.tmp` sidecar when the caller removed the staging directory, `fs.WriteStream` emitted an unhandled `'error'` event (`ENOENT`) and crashed the process.
- **Decision:** attach an `'error'` listener when creating each download `WriteStream`, await `'open'` before streaming, and ensure `close()` waits for `'close'` and runs in `finally` on every exit path. In `Downloader.run`, abort sibling transfers via a per-batch `AbortController` when any item fails and await `Promise.allSettled` across all items before rethrowing the first error.
- **Consequences:** callers that clean up a staging directory after `Downloader.download` rejects no longer race with background `WriteStream` opens or open file descriptors, and any filesystem open failure is surfaced as a standard `Error: [disk_*]` rejection instead of an uncaught exception. Public contracts, progress events and retry semantics are unchanged.
- **Owner:** `team`.
- **Links:** `src/downloads/downloader.ts`, `src/downloads/downloader.test.ts`.
