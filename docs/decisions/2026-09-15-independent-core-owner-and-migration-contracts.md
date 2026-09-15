---
date: 2026-09-15
title: "Independent core owner and migration contracts"
---

# 2026-09-15 — Independent core owner and migration contracts

- **Context:** The original plan put control and public inference on one listener, distributed the CLI
  before attach/legacy coordination, and treated dual-write and event replay as sufficient recovery.
  Public-server shutdown could disconnect control; the app's name/path-based reaper could kill a live
  CLI backend; CLI edits and downgrade could leave conflicting settings without a resolution rule.
- **Decision:** One standalone owner per canonical data folder; app and CLI attach and detach independently.
  Control uses a permanent authenticated loopback HTTP listener, public inference a separate configurable
  listener. Tauri relays control through Rust; no browser control token or CORS exception is required.
  Client exit does not stop the owner. Global shutdown is explicit, checks other active clients, and
  requires a distinct force option to interrupt them. Standalone mode requires a separate data folder.
- **Ownership and recovery:** Deliver lock/attach and process-identity checks before CLI distribution,
  together with a legacy resource guard and owner-aware app reaper. Track children in
  `<data>/atomic-core/processes.json`; validate identities before orphan cleanup. Use an instance id,
  consistent snapshot cursor and one SSE stream; overflow or a new instance requires resync. Stdout
  carries only the bootstrap ready line. Dead sessions are invalidated, never silently reused/reloaded.
- **Migration:** Import each scope before its first core operation; core revisions, a shared baseline
  and acknowledged legacy mirrors reconcile changes from CLI and old app versions. Same-field conflicts
  require resolution before transfer. All remaining legacy session providers, including TurboQuant,
  register with owner generation/expiry until migrated. Public-server/auth/state-file ownership transfers
  are serialized and have explicit failure recovery. Desktop cleanup preserves required mobile paths.
- **Contract evidence:** Compare meaningful behavior and fields, normalize only documented dynamic
  values, and preserve unknown YAML/JSON fields. Do not promise incidental key order or network chunk
  identity. Pin fixture source commits. A signed universal artifact must execute on both macOS
  architectures before distribution; Node SEA is an unverified alternative until separately packaged,
  signed and tested, not a one-line fallback.
- **Consequences:** Two listeners and explicit ownership/reconciliation add implementation work up front.
  They allow public API shutdown without losing model control, app/CLI coexistence and recoverable
  migration. A daemon can retain memory after app exit until explicit unload/shutdown. Downgrade without
  synchronizing the legacy mirror cannot guarantee fresh settings in the old UI; concurrent use of an
  old uncoordinated app with the new core on the same data folder is unsupported. Current TS scaffolding
  must be updated in the corresponding implementation phases; this decision changes the plan only.
- **Owner:** team.
- **Links:** [PLAN.md](../../PLAN.md) §3.4–3.6, §4–6;
  [contracts](../contracts.md); [app-e2e](../app-e2e.md).

Supersedes: [shared-listener sidecar protocol](2026-09-15-sidecar-control-protocol-is-http-plus-sse.md).
Partially supersedes: [Node-compatible API packaged with Bun](2026-09-15-core-is-typescript-node-compatible-api-packaged-with-bun.md)
only for its unverified one-script Node SEA fallback claim; the language and packaging choice remain.
