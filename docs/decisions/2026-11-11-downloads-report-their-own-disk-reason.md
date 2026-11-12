---
date: 2026-11-11
title: "Downloads report the disk reason they already tag"
---

# 2026-11-11 — Downloads report the disk reason they already tag

- **Context:** A download failed with `Error: downloads download: unknown` on core 0.21.2 (ATOMIC-CHAT-CORE-9S). The stack is the post-transfer `stat` of the `.tmp` partial in `downloadOne`; the thrown error is `Error: [disk_device_lost] ENOENT: …` with the fs error as `cause`. The downloader already names the failure in its own taxonomy (`src/downloads/disk.ts` maps `ENOENT` to `disk_device_lost`), but the wrapping `Error` carried no diagnostic, and `classifyFailure` has no `ENOENT` entry in its operational table. The report therefore had `failure_reason=unknown`, `failure_category=unknown`, level `error`, and grouped on a source location instead of the failure kind. Preflight refusals already avoid this by attaching a non-enumerable `diagnostic` in `preflightFailure`.
- **Decision:** Every fs error wrapped by `diskFailure` in `src/downloads/downloader.ts` attaches a non-enumerable `diagnostic` whose `reason` is `classifyIoError(error)` and whose `category` is `operational`, mirroring `preflightFailure`. The thrown message (`Error: [<tag>] …`), the `cause`, the ErrorBody, the sidecars, retry/cancel behaviour and the reporter remain unchanged. Reporting classifies a vanished staging file as `disk_device_lost` at warning level, with `cause_code=ENOENT` beside it.
- **Consequences:** Failures that previously read `unknown` now name the disk reason (`disk_device_lost`, `disk_full`, `disk_permission`, `disk_file_locked`, `disk_path_too_long`, `disk_fs_limit`, `disk_io`) and are reported as operational rather than as defects. The diagnostic is internal telemetry vocabulary, not part of any public contract. Which actor removed the partial (concurrent cleanup, antivirus, a superseding task) is still not recorded; this change only makes the observed failure legible. Tooling that matches the tagged message text continues to work.
- **Owner:** team
- **Links:** ATOMIC-CHAT-CORE-9S, `src/downloads/downloader.ts`, `src/downloads/disk.ts`, `src/telemetry/diagnostics.ts`, `src/downloads/downloader-diagnostic.test.ts`
