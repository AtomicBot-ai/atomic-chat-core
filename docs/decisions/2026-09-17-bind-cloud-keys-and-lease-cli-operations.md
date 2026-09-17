---
date: 2026-09-17
title: "Bind cloud keys to destinations and lease CLI operations"
---

# 2026-09-17 — Bind cloud keys to destinations and lease CLI operations

- **Context:** Cloud provider settings and API keys live in separate files. A key write became visible before the matching URL write, so requests during that interval—or after a crash—could send a new key to an old destination. CLI commands also did not register while working, making an active command indistinguishable from an idle daemon during upgrade.
- **Decision:** Credential records may carry `bound_to`, a SHA-256 digest of the canonical non-secret provider definition (id, URL, headers and models). The registry writes the new bound credential before settings and routes only when the binding matches; legacy records without a binding remain readable and acquire one on their first edit. CLI commands that contact a daemon register, heartbeat and unregister for their operation's duration. An accepted shutdown closes client admission synchronously.
- **Consequences:** A provider can be temporarily unavailable during a two-file update or after an interrupted update, but its key cannot be sent to a mismatched destination. Existing credential files need no migration. CLI 0.2+ refuses idle-daemon replacement while a command has a live lease; a 0.1 daemon cannot expose its in-flight commands, so its automatic replacement can still interrupt one.
- **Owner:** team.
- **Links:** [app decision](../../../Atomic-Chat/docs/decisions/2026-09-17-reconcile-core-server-ownership.md), [stage 4 plan](../../PLAN.md).
