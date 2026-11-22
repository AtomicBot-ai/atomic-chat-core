---
date: 2026-11-22
title: "Preserve the launch-check failure on refused backend installs"
---

# 2026-11-22 — Preserve the launch-check failure on refused backend installs

- **Context:** `BackendService.install` refuses a downloaded pack that fails its launch check and keeps the current backend. The refusal is a plain `Error` built from the check's message only: the wrapper in `src/backend/install/service.ts` discarded the object the check threw, so the inner failure never reached `errorChain`. The install catch reports through `onFailure(e, { component: 'backend', operation: 'install' })`, so every such instance was recorded at `error` level as the synthesized value `backend install: unknown`, with no `cause_code` and no way to tell the failures apart. This is the same severing that ADR 2026-11-06 fixed one layer up in `installError`, which left this install-local wrapper untouched.
- **Decision:** Pass `{ cause: error }` to the `Error` the wrapper throws, leaving its message and the caller-visible refusal unchanged.
- **Consequences:** The reporter keeps the underlying launch-check error, so `errorCodeOf` and the Sentry cause chain see it: a code the classifier already maps (for example `EACCES` → `disk_permission`) now yields an operational reason instead of `unknown`. `ErrorBody`, the thrown type and the "current backend stays" behavior do not change. Codes the classification table does not list still report `unknown`; widening that table is a telemetry change and is not made here. Failures that never had a cause — notably archive extraction, which surfaces yauzl frames instead — are also unchanged and remain a separate question.
- **Owner:** team.
- **Links:** `src/backend/install/service.ts`, `src/backend/install/service-launch-check-cause.test.ts`, `docs/decisions/2026-11-06-preserve-cause-on-llamacpp-engine-install-errors.md`.
