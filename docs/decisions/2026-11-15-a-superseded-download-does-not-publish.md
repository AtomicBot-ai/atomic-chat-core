---
date: 2026-11-15
title: "A superseded download stands back before it publishes"
---

# 2026-11-15 — A superseded download stands back before it publishes

- **Context:** `Downloader.download` supersedes an earlier call with the same task id by aborting it, and the doc comment promises the superseded run "leaves the files to the newcomer". The abort was only consulted while a chunk arrived, inside the read loop of `downloadOne`. An attempt whose body had already ended — or which was blocked in `reader.read()` and then saw `done` — walked past the loop into the publish block: it renamed the shared `<save>.tmp` to `<save>` and removed `<save>.url`, then failed its own post-transfer verification with `Validation cancelled`. The verification-failure branch of `run` removes the published file and its directory, so the live attempt's next `stat(tmpPath)` threw `ENOENT`, reported as `[disk_device_lost] ENOENT` for a download that had lost nothing of its own.
- **Decision:** Abort the superseded attempt and wait for its filesystem operations to settle before
  the same task ID starts again. Cancel its response reader to unblock a stalled read. Check for
  cancellation before publishing a partial and before cleaning up after verification.
- **Consequences:** An already-submitted rename or cleanup can finish before the next attempt touches
  the shared files. Cancellation leaves partials and completed files available to the next attempt,
  including when it interrupts the hash check. Other task IDs can still run concurrently, and a
  real staging-directory failure retains its existing disk diagnostic.
- **Owner:** team.
- **Links:** `src/downloads/downloader.ts` (`downloadOne`), `src/downloads/downloader-supersede-race.test.ts`.
