---
date: 2026-11-05
title: "Tag sd.cpp install probe failures with finite diagnostic codes"
---

# 2026-11-05 — Tag sd.cpp install probe failures with finite diagnostic codes

- **Context:** When `prepareSdcppTree` and `probeBinary` in `src/diffusion/install.ts` verify an unpacked `sd-cli` or `sd-server` binary with `--help`, they raise `ENGINE_INSTALL_FAILED` across six distinct failure branches (dynamic library load failure, silent exit or signal termination, unexpected non-`stable-diffusion.cpp` output, `--help` timeout, process spawn failure, or missing `sd-server` in the archive). Core telemetry scrubs raw error messages and details to `http request: unknown`, leaving Sentry events unable to distinguish which probe failure branch occurred on macOS arm64.
- **Decision:** Use the bounded diagnostic observer to map the six exact `ENGINE_INSTALL_FAILED` messages in `src/diffusion/install.ts` to finite `diagnostic_code` tags and enable allowlisted `diagnostic_cause_code` capture on existing error events.
- **Consequences:** Future `ENGINE_INSTALL_FAILED` events carry finite `diagnostic_code` and `diagnostic_cause_code` tags without exposing raw paths, engine output, or changing error classification, filtering, or caller-visible behavior. Remove or replace these temporary rules once Sentry events identify the failing macOS arm64 probe branch and the underlying issue is resolved.
- **Owner:** `team`
- **Links:** `src/diffusion/install.ts`, `src/telemetry/diagnostics.ts`, `src/telemetry/sentry-agent-diagnostics.ts`, `src/telemetry/sentry-agent-diagnostics.test.ts`
