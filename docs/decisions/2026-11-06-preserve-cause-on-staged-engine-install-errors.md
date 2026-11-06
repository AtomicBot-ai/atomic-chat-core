---
date: 2026-11-06
title: "Preserve error cause on staged engine-build install failures"
---

# 2026-11-06 — Preserve error cause on staged engine-build install failures

- **Context:** When `installStaged` and `downloadError` in `src/engine-builds/install.ts` caught a non-`AtomicCoreError` during archive download, archive extraction, or staging/filesystem operations, they wrapped it into a new `AtomicCoreError('ENGINE_INSTALL_FAILED' | 'CANCELLED', ...)` without passing `{ cause: error }`. Because the `Error.cause` chain was severed, `errorChain(error)` at the `ControlServer` HTTP catch boundary could not inspect the underlying OS/filesystem `code` (such as `EPERM`, `EACCES`, `EBUSY`, or `ENOSPC`) or match errors already reported by `Downloader.onFailure`. Consequently, `control_route` emitted uncategorized `ENGINE_INSTALL_FAILED: http request: unknown` events with `cause_code=ENGINE_INSTALL_FAILED` and failed to deduplicate already-reported download errors.
- **Decision:** Pass `{ cause: error }` whenever `installStaged` and `downloadError` in `src/engine-builds/install.ts` construct a wrapping `AtomicCoreError`.
- **Consequences:** `ErrorBody` and `toJSON()` remain unchanged on the wire, while `errorChain` retains the underlying install error across `installStaged`, preserving operational diagnostic classification, `cause_code`, `diagnostic_cause_code`, and `ErrorReporter` cross-boundary deduplication.
- **Owner:** team.
- **Links:** `src/engine-builds/install.ts`, `src/engine-builds/install-error-cause.test.ts`, `docs/decisions/2026-11-03-keep-failure-diagnostics-outside-the-wire-contract.md`, `docs/decisions/2026-11-06-preserve-cause-on-llamacpp-engine-install-errors.md`.
