---
date: 2026-11-05
title: "Bound GPU probe and MLX binary lookup diagnostics"
---

# 2026-11-05 — Bound GPU probe and MLX binary lookup diagnostics

- **Context:** Sentry `ATOMIC-CHAT-CORE-5W` and `5Y` share `DEVICE_LIST_PARSE_FAILED`
  but one path times out waiting for `--list-devices` and another receives no parseable header.
  `ATOMIC-CHAT-CORE-6Z` reports `BINARY_NOT_FOUND` without distinguishing an unresolved MLX
  engine from a missing explicit, resolver-selected, or resources-directory executable. Existing events do not prove
  a native engine defect or an installer-path defect.
- **Decision:** Attach a finite internal `operationDetail` diagnostic to these failure sites.
  Report its validated value as `operation_detail`, alongside the stage and the device probe's
  original exit code/signal. A probe deliberately terminated after its deadline remains a timeout:
  its termination signal is not evidence of a native crash. Preserve a spawn error as the cause.
  Distinguish the four MLX lookup paths using only control flow, without reporting a filesystem path. The resolver can choose either a bundled or downloaded build, so its result is labelled resolved rather than installed.
- **Consequences:** Existing `ErrorBody` codes, messages and details are unchanged; the private
  diagnostic stays outside JSON error responses. No raw stdout/stderr, model names, user paths,
  extra probes, longer timeouts, suppressed reports, new dependencies, or automatic repairs are
  introduced. These small facts can remain with the failures; they do not increase event volume
  or change the observer cooldown. Root-cause repair still requires new evidence and, for native
  GPU/MLX behavior, validation on the affected engine/platform.
- **Owner:** team.
- **Links:** <https://atomic-chat.sentry.io/issues/7828994285/>;
  <https://atomic-chat.sentry.io/issues/7829812509/>;
  <https://atomic-chat.sentry.io/issues/7830182401/>;
  `src/runtime/{llamacpp,mlx}/runtime.test.ts`; `src/telemetry/diagnostics.test.ts`.
