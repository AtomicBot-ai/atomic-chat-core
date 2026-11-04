---
date: 2026-11-03
title: "Keep failure diagnostics outside the wire contract"
---

# 2026-11-03 — Keep failure diagnostics outside the wire contract

- **Context:** The Sentry fixer in atomic-hatchet-pipeline only supported atomic-server. Core already
  reported errors, but an HTTP boundary excluded every AtomicCoreError, including INTERNAL_ERROR.
  Background decision/embedding failures lost their original Error before the public event, and
  broad model-load fingerprints merged unrelated unknown failures. ErrorBody and the existing SSE
  payloads are contracts consumed by the app and must not acquire private diagnostics.
- **Decision:** Add optional cause and finite diagnostics to AtomicCoreError's fourth constructor
  argument. Both are non-enumerable and absent from toJSON/fromBody, HTTP, SSE and operation records.
  Classify observations as expected, operational, defect or unknown at the reporting boundary.
  Expected answers and cancellation are quiet; resource/environment failures are warnings; unknown
  failures and defects are errors; unhandled process failures remain fatal. An IO_ERROR without a
  known cause remains unknown. This supersedes the blanket coded-error exclusion and the suppression
  of resource failures in the original reporting policy, not the consent decision.
- **Decision:** Inject an internal failure observer into background services before they reduce an
  Error to public state. The owner retains the existing wire events and subscribes to session death;
  diffusion reports through its observer instead of also reporting its public event. Reporters dedup
  propagation by Error identity (including a bounded cause chain), and group by component, operation,
  finite reason, provider and original source location for unknown/internal failures. Grouping uses
  neither the message nor the user-selected model. Existing consent, hourly caps and time windows
  remain. Every newly emitted report carries a generic message and no free-text logs/details,
  breadcrumbs or model IDs; old stored events remain readable by the pipeline. Scrubbing arbitrary
  messages cannot guarantee removal of a user's prompt. Cause exceptions carry safe types/codes and source frames,
  never arbitrary cause values or messages. Cycles and depth are bounded.
- **Decision:** The separate core profile owns core-project events from every host, including atc.
  Automatic collection covers production/prerelease; source is a manual dry-run and cannot be
  published. Only a reproduced local TypeScript repair may become a PR. Public-contract changes,
  telemetry changes, and native/platform failures without a runnable regression require a human.
  Linux checks do not replace the platform CI or app-e2e. npm source positions require an integrity-
  checked package with the matching release gitHead; unavailable maps are an explicit evidence gap.
- **Consequences:** New grouping intentionally starts new Sentry groups. Legacy events remain readable.
  More operational failures are observable but still bounded by the existing caps. A reused Error
  instance is one observation for its lifetime; independent failures should construct new Errors.
  No new dependency or on-disk path is introduced. The pipeline's core profile remains disabled until
  real Docker/model dry-runs establish readiness; local unit tests do not prove deployment readiness.
- **Owner:** team.
- **Links:** `src/contracts/diagnostics.ts`, `src/telemetry/diagnostics.ts`, `test/e2e/telemetry.test.ts`;
  sibling `atomic-hatchet-pipeline/docs/core-sentry-profile.md`.
