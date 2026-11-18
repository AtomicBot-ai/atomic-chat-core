---
date: 2026-11-18
title: "Tag cancelled backend install events with a finite diagnostic code"
---

# 2026-11-18 — Tag cancelled backend install events with a finite diagnostic code

- **Context:** Error-level Sentry events from `atomic-chat-core@0.23.4` carry
  `component=backend`, `operation=install`, `failure_reason=unknown`, and the exception value
  `backend install: unknown`. That value is synthesized at the envelope boundary from component,
  operation and reason (`src/telemetry/envelope.ts`), so the original error message never reaches
  Sentry. The only in-app frame is `src/downloads/downloader.ts:689`, the statement
  `if (signal.aborted) throw new Error(DOWNLOAD_CANCELLED)` inside `downloadOne`; the sentinel's
  message is `Download cancelled`. `BackendService.install` reports every thrown error through
  `onFailure` before rethrowing it (`src/backend/install/service.ts`), and
  `classifyFailure`/`isCancellation` recognise only named cancellation codes and `AbortError`, so a
  plain `Error('Download cancelled')` is reported as an unknown error. Whether such an event really
  is a user cancellation is therefore an observation gap, not a proven cause.
- **Decision:** Add one exact-message rule to the bounded diagnostic observer
  (`src/telemetry/sentry-agent-diagnostics.ts`) mapping `Download cancelled` to
  `DOWNLOAD_SENTINEL_CANCELLED`, so existing operation events for this stack gain the finite tag
  `diagnostic_code`. Nothing else changes: classification, filtering, severity, consent, throttling,
  grouping and reporting frequency stay as they are, and the caller-visible outcome remains the same
  error.
- **Consequences:** Real events will confirm or refute that the unknown-reason backend install
  failures are the downloader's cancellation sentinel before anyone touches reporting behaviour.
  The tag only observes; it does not silence the event. If the tag appears on future events, the core
  owner can decide whether a cancelled install should be skipped by the install observer, mirroring
  `Downloader.download`'s existing abort guard, or whether the cancellation sentinels should be
  recognised by `isCancellation`. Both are telemetry/filtering changes and need separate approval.
  The rule should be removed once cancellation is classified as expected or the install service stops
  reporting a cancelled download and one release has produced no tagged events.
- **Owner:** team.
- **Links:** issue ATOMIC-CHAT-CORE-BG (atomic-chat-core, event release
  `atomic-chat-core@0.23.4`, dist `c21d7796d3b2`); `src/downloads/downloader.ts`,
  `src/backend/install/service.ts`, `src/telemetry/diagnostics.ts`,
  `src/telemetry/sentry-agent-diagnostics.test.ts`.
