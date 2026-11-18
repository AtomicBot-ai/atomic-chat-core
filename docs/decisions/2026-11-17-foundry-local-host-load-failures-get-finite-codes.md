---
date: 2026-11-17
title: "Tag Foundry Local host load failures at their source"
---

# 2026-11-17 — Tag Foundry Local host load failures at their source

## Context

Foundry Local emits `FOUNDRY_LOCAL_HOST_ERROR` for several host exits before model readiness.
An exit with code 3 means library loading failed or the native API was incompatible. Other
early exits include failures before the library loads, so the generic host error cannot establish
which startup stage the process reached. The install-time probe uses the same library message
when it returns an unreadable response, even with an exit code of zero.

## Decision

In the runtime's exit handler, use the existing `operation_detail` tag to distinguish
`foundry_local_library_not_loaded` for exit 3 and `foundry_local_host_stopped_before_ready`
for the remaining `FOUNDRY_LOCAL_HOST_ERROR` exits. Exit 5 keeps its accelerator refusal.
The install-time probe does not use either load detail.

## Consequences

Sentry can split existing Foundry model-load failures by `operation_detail`, while clients keep
the same error code, message and details. The tag contains a fixed value from the diagnostic
contract. Grouping and severity retain their existing rules.

Owner: team

References: `src/runtime/foundry-local/runtime.ts`, `src/runtime/foundry-local/host-process.ts`,
Sentry `ATOMIC-CHAT-CORE-CM`.
