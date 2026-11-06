---
date: 2026-11-06
title: "Preserve error cause on llama.cpp engine update install failures"
---

# 2026-11-06 — Preserve error cause on llama.cpp engine update install failures

- **Context:** When `LlamacppEngine.updateHeld` in `src/engines/llamacpp.ts` caught a non-`AtomicCoreError` thrown by `BackendService.install`, `installError` wrapped it into `new AtomicCoreError('ENGINE_INSTALL_FAILED', message)` (or `'CANCELLED'`) without passing `{ cause: error }`. Because the `Error.cause` chain was severed, `errorChain(error)` at the `ControlServer` HTTP catch boundary no longer included the underlying `Error` that `BackendService.install` or `Downloader.download` had already reported via `onFailure`, nor its attached `FailureDiagnostic` or OS/network `code`. Consequently, `ErrorReporter` could not deduplicate the already-reported failure against `reportedErrors` and emitted a duplicate uncategorized `ENGINE_INSTALL_FAILED: http request: unknown` event at level `error`.
- **Decision:** Pass `{ cause: error }` when `installError` in `src/engines/llamacpp.ts` constructs `AtomicCoreError` for both `'CANCELLED'` and `'ENGINE_INSTALL_FAILED'`.
- **Consequences:** `ErrorBody` and `toJSON()` remain unchanged on the wire, while `errorChain` retains the underlying install error across `LlamacppEngine.update`, preserving diagnostic classification, `cause_code`, and `ErrorReporter` cross-boundary deduplication.
- **Owner:** team.
- **Links:** `src/engines/llamacpp.ts`, `src/engines/llamacpp-install-error-cause.test.ts`, `docs/decisions/2026-11-03-keep-failure-diagnostics-outside-the-wire-contract.md`.
