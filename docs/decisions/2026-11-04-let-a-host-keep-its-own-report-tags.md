---
date: 2026-11-04
title: "Let a host keep its own report tags"
---

# 2026-11-04 — Let a host keep its own report tags

- **Context:** Atomic Server (`atc`) sends the failures of its own code through the core's `ErrorReporter` to its own Sentry project, tagged with its part of the program (`component: tui`, `admin`, `daemon`, …), the operation and finite diagnostic codes (`diagnostic_code`, `diagnostic_cause_code`, `native_failure`); its Sentry triage reads those tags. Since 0.21.1 (`2026-11-03-keep-failure-diagnostics-outside-the-wire-contract.md`) the event keeps only the core's report keys and the core's diagnostic vocabulary, which has no word for a host's parts: every `atc` report arrived as `component: core`, `operation: event`, without its codes, and grouped as such.
- **Decision:** `ErrorReporterOptions.hostTagKeys` names the tag keys a host sets on the reports it captures itself. Those keys pass, scrubbed and capped like every tag, after the core's diagnostic tags, so they win on the same key; a host `component` and `operation` also name the exception and the fingerprint. The core's own reporter passes none, so its events are unchanged. The host vouches that the values are finite. A failure with no stack location adds its exception type to the fingerprint's location (`no-stack:TypeError`): `atc` forwards browser failures whose frames it cannot accept, and two of different types were one issue and deduplicated for a minute.
- **Consequences:** `atc` pins this release with `hostTagKeys` for its keys and gets its tags and grouping back. Messages still never leave; the core's classification (`failure_category`, `failure_reason`, `cause_code`) stays beside the host's tags.
- **Owner:** team.
- **Links:** `src/telemetry/envelope.ts`, `src/telemetry/reporter.ts`, `src/telemetry/diagnostics.ts` (`diagnosticFingerprint`), AtomicBot-ai/atomic-server#63, AtomicBot-ai/atomic-server#73.
