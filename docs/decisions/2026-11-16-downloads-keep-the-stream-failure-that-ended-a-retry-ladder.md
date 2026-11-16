---
date: 2026-11-16
title: "Keep the stream failure that ended a download retry ladder"
---

# 2026-11-16 — Keep the stream failure that ended a download retry ladder

- **Context:** When a transfer errored at the same byte five times, `Downloader.downloadOne` gave up and threw `Download failed after N retries at byte X: <message>` with `{ cause: streamError }`, where `streamError` was the caught failure's *message string*. `errorChain` in `src/telemetry/diagnostics.ts` walks `Error.cause` only while the entry is an `Error`, so the chain ended on that string: no `code`, no `diagnostic`, no `TypeError`, therefore category and reason `unknown`, level `error`, and the report rendered the boundary template `downloads download: unknown` (ATOMIC-CHAT-CORE-CE). Every other terminal throw in the file keeps a classifiable fact — `preflightFailure` and `diskFailure` attach a `diagnostic`, `rethrowAsString` keeps `{ cause: e }` — so this branch was the only one that destroyed the evidence.
- **Decision:** Keep the caught object beside its message and throw the retry-exhaustion error with `{ cause: streamCause ?? streamError }`. The message text is unchanged, so the caller-visible `Error` and every string consumer stay byte-identical; only the cause type changes, from a string to the original `Error` when one was caught. The `?? streamError` fallback keeps the string for the synthetic "stream ended after … of … bytes" case, which has no throwable behind it.
- **Consequences:** A coded read failure (`ECONNRESET`, `ETIMEDOUT`, `EIO`, …) now maps to its operational reason instead of `unknown`, so `downloads download` reports `network` and `warning` and groups by failure kind rather than by source line. Failure modes whose code is not in `REPORTABLE_CODES` still classify as `unknown`; the object is preserved, but the classifier's allowlist is unchanged. Retry counts, cancellation, disk handling, sidecars, `ErrorBody` and the reporter are untouched.
- **Owner:** `team`.
- **Links:** `src/downloads/downloader.ts` (`downloadOne`), `src/telemetry/diagnostics.ts` (`errorChain`), `src/downloads/downloader-stream-cause.test.ts`. Precedents: `2026-11-11-downloads-report-their-own-disk-reason.md`, `2026-11-06-preserve-cause-on-staged-engine-install-errors.md`.
