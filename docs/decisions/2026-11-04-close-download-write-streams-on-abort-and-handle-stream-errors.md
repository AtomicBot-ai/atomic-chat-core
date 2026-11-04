---
date: 2026-11-04
title: "Close download write streams on abort and handle stream errors"
---

# 2026-11-04 — Close download write streams on abort and handle stream errors

- **Context:** `Downloader.downloadOne` in `src/downloads/downloader.ts` created `fs.WriteStream` instances for `<save_path>.tmp` without attaching an `'error'` listener, waited only on `writer.end(cb)` (`'finish'`) rather than `'close'`, and threw `DOWNLOAD_CANCELLED` from the `reader.read()` catch block without closing and awaiting the `WriteStream`. When an engine-build download in `installStaged` was cancelled or aborted right after `createWriteStream(tmpPath)` started its asynchronous `fs.open`, `installStaged`'s `cleanup()` removed the `.incoming-<timestamp>.download` staging directory while `fs.open` was still in flight on the libuv threadpool, causing `fs.open` to fail with `ENOENT` and emit an unhandled `'error'` event on the `WriteStream` that crashed the daemon as an `uncaught_exception`.
- **Decision:** Wrap every `fs.WriteStream` created in `Downloader.downloadOne` with an immediate `'error'` listener, wait for the stream's `'close'` event when closing, ensure `writer.close()` is awaited in a `finally` block before `downloadOne` exits on abort or error, and wait for all item downloads in a batch to settle before `Downloader.run` rejects.
- **Consequences:** Cancelling or failing a staged download never leaves an asynchronous `fs.open` or `fs.close` in flight when staging directories are cleaned up, and any asynchronous `WriteStream` open/write/close error rejects the download promise with a `[disk_*]` error rather than crashing the process with an unhandled `'error'` event. Public wire contracts, download resume semantics, and progress events remain unchanged.
- **Owner:** `team`.
- **Links:** `src/downloads/downloader.ts`, `src/downloads/downloader.test.ts`, `src/engine-builds/install.ts`.
