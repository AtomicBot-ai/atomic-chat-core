---
date: 2026-11-12
title: "Tag MLX install probe failures with finite diagnostic codes"
---

# 2026-11-12 — Tag MLX install probe failures with finite diagnostic codes

- **Context:** `probeMlxServer` in `src/engine-builds/builds.ts` verifies a freshly unpacked `mlx-server` with `--help`. `mlxProbePassed` collapses a missing binary, a `--help` timeout, a spawn failure and a run that exits non-zero or prints no argparse usage into `ENGINE_INSTALL_FAILED`. Core telemetry scrubs the error message and details to `http request: unknown`, so an event cannot say which probe branch refused the install, and the exit status only exists in `AtomicCoreError.details`, which the envelope drops.
- **Decision:** Use the bounded diagnostic observer to map the four exact `ENGINE_INSTALL_FAILED` messages of `probeMlxServer` to finite `diagnostic_code` tags, with allowlisted `diagnostic_cause_code` capture, on existing error events only.
- **Consequences:** Future MLX install failures carry `diagnostic_code` values `MLX_PROBE_DOES_NOT_RUN`, `MLX_ARCHIVE_MISSING_SERVER`, `MLX_PROBE_HELP_TIMEOUT` or `MLX_PROBE_START_FAILED`, separating the probe branches from download, unpack and record failures without exposing paths, output or changing classification, filtering, event count or the caller-visible refusal. This observes; it does not repair the install path. Remove or replace these rules once an event names the branch and the macOS cause behind it is fixed or deliberately accepted.
- **Owner:** `team`
- **Links:** `src/engine-builds/builds.ts`, `src/telemetry/diagnostics.ts`, `src/telemetry/sentry-agent-diagnostics.ts`, `src/telemetry/sentry-agent-diagnostics.test.ts`
