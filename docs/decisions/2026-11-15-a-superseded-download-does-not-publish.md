---
date: 2026-11-15
title: "A superseded download stands back before it publishes"
---

# 2026-11-15 — A superseded download stands back before it publishes

- **Context:** `Downloader.download` supersedes an earlier call with the same task id by aborting it, and the doc comment promises the superseded run "leaves the files to the newcomer". The abort was only consulted while a chunk arrived, inside the read loop of `downloadOne`. An attempt whose body had already ended — or which was blocked in `reader.read()` and then saw `done` — walked past the loop into the publish block: it renamed the shared `<save>.tmp` to `<save>` and removed `<save>.url`, then failed its own post-transfer verification with `Validation cancelled`. The verification-failure branch of `run` removes the published file and its directory, so the live attempt's next `stat(tmpPath)` threw `ENOENT`, reported as `[disk_device_lost] ENOENT` for a download that had lost nothing of its own.
- **Decision:** Check `signal.aborted` once immediately after the transfer loop closes and before the persisted-size check and the `rename`/`rm(urlPath)`. A superseded or cancelled attempt then throws `DOWNLOAD_CANCELLED` and leaves the `.tmp` partial in place, where the newcomer's write stream or the existing `downloaded === expectedSize` resume branch owns it. Nothing else changes: aborted attempts stay unreported (`download()` only calls `onFailure` for a task whose own signal is not aborted), and every message, tag and public contract is untouched.
- **Consequences:** A retry with the same task id can no longer be killed by the attempt it replaced, so the `[disk_device_lost] ENOENT` warning disappears for that trigger. Other `ENOENT` sources (an actually vanishing volume or staging directory) still report the same tag. The guard covers cancel-after-body-end as well, since a cancelled task also has an aborted signal. Cost: one boolean check per file.
- **Owner:** team.
- **Links:** `src/downloads/downloader.ts` (`downloadOne`), `src/downloads/downloader-supersede-race.test.ts`.
