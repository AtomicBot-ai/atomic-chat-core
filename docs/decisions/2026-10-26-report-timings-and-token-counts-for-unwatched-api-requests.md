---
date: 2026-10-26
title: "Report timings and token counts for API requests nobody watched"
---

# 2026-10-26 — Report timings and token counts for API requests nobody watched

- **Context:** `api:request` `finished` carried the inspector's finish fields only for a request the
  app's API screen watched when it arrived (`announced`). One that came while no Server page was
  open — the app's own "Send test request" on Connections, any outside client — got
  `finish: null` and only the analytics observation (status, time to headers). The app lists such
  a request since app ADR 2026-10-21-list-unwatched-api-requests-in-activity-without-previews, but
  with every timing and token column a dash: app 2.2.25 QA F-01 / NEW-05 (a 1.2 s local chat
  completion listed as "Completed", nothing else). A non-streamed local answer was already read
  whole and parsed for the context cut-off check; its `usage` and `timings` were dropped unread.
- **Decision:** `RequestTrace` builds the finish fields for every request it reports, watched or
  not: duration, time to headers, time to first token, prompt/completion/total tokens, the
  engine's rates, finish reason, reply length. Only the previews stay tied to watching
  (ATO-113): `StreamTelemetry({ previews: false })` keeps no reply text at all, and `close()`
  sends `reply_preview: null` for an unwatched request whatever was collected. A non-streamed
  local answer feeds its already-parsed body to telemetry; a stream nobody watches goes through
  the observed relay too, with its numbers from `usage` or llama.cpp's final `timings`. The
  `include_usage` injection and its trailer stripping stay watched-only, so an unwatched request
  reaches the engine exactly as the client sent it.
- **Consequences:** Additive on the wire: `finished` with `seq` -1 now has a `finish` object. App
  builds that read only the observation (2.2.25) ignore it; the app change that reads it ships in
  the same pair of PRs. An unwatched stream's bytes are now split at line boundaries like a
  watched one's (same bytes, possibly different chunking) and each `data:` line is JSON-parsed —
  microseconds per token, against a model's milliseconds. An unwatched stream to an engine that
  reports neither `usage` nor `timings` (MLX, remote providers) has estimated completion tokens
  and no prompt count. Started and progress events are unchanged: still watched-only.
- **Owner:** team
- **Links:** `src/server/public/trace.ts`, `src/server/public/telemetry.ts`,
  `src/server/public/forward.ts` (`inspectFinish`, `relayObserved`), `src/contracts/events.ts`
  (`ApiRequestEvent`), `test/e2e/api-events.test.ts`, app `request_inspector.rs`
  (`record_unannounced_core_request`).
