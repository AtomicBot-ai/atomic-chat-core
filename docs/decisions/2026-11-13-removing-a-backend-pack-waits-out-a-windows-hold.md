---
date: 2026-11-13
title: "Wait out a Windows hold before deleting a backend pack"
---

# 2026-11-13 — Wait out a Windows hold before deleting a backend pack

- **Context:** `BackendService.remove()` deleted an installed pack with a single
  `rm(target, { recursive: true, force: true })`, while every other rename or removal the install
  makes went through `retryTransientFs` / `moveWithRetry` (`src/downloads/fs-retry.ts`). On Windows a
  pack that was running a moment ago is often still open elsewhere: a `llama-server.exe` that has
  only just exited, antivirus reading the freshly written DLLs, or the search indexer walking the
  directory. Those holds surface as `EPERM` / `EBUSY` / `EACCES` / `ENOTEMPTY` and clear within
  seconds. The unretried deletion turned such a hold into a failed `DELETE /engines/...`, reported as
  a 500 whose message renders as `http request: disk_file_locked`, and the pack stayed on disk.
- **Decision:** Run that deletion inside `retryTransientFs` with the same platform and the same
  `moveRetry` policy the install's moves use, so a transient Windows hold is waited out (eight
  attempts over ~10 s on `win32` only). The ladder is applied to the deletion alone: the
  `BACKEND_IN_USE` refusal, the bundled/active refusals, the operation slot and the load-queue turn
  are unchanged, and the pack is still asked about before anything is deleted. A hold that outlasts
  the ladder is rethrown unchanged, so it is reported exactly as it is today.
- **Consequences:** Removing a pack on Windows stops failing on the ordinary "the file is still
  closing" race; on Linux and macOS nothing changes, because `retryTransientFs` retries only on
  `win32`. A genuinely held pack still fails, and now takes up to ten seconds of attempts before it
  does. The error type, message shape and telemetry classification are untouched, so no consumer of
  the removal route has to change.
- **Owner:** team.
- **Links:** `src/backend/install/service.ts` (`remove`), `src/downloads/fs-retry.ts`,
  `src/backend/install/service-remove-retry.test.ts`, Sentry ATOMIC-CHAT-CORE-B5
  (`http request: disk_file_locked`, release `atomic-chat-core@0.21.2`).
