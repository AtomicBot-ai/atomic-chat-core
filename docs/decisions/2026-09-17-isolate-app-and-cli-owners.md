---
date: 2026-09-17
title: "Isolate app and CLI core owners"
---

# 2026-09-17 — Isolate app and CLI core owners

- **Context:** One data-folder owner could not both die with the desktop app and remain alive for independent CLI commands. Its lock, credentials, model files and listener also conflated two products' state.
- **Decision:** Build two entry points at the same pinned version: `atomic-chat-app-core` accepts only app daemon startup; `atomic-chat-core` is the user CLI and its `jan-cli` copy. CLI defaults to `<system data>/atomic-chat-cli/data`, refuses aliases of the configured app folder and keeps its daemon alive. The app retains its folder and owns shutdown after full exit or all flags off; expiry of its client registration stops the app owner after a crash. Lock, settings and authenticated health/snapshot advertise `app` or `cli`. No migration or copying of models/secrets.
- **Lifecycle and review repairs:** Version mismatch never counts as a compatible attachment. An idle old CLI daemon may be shut down and replaced; an active one refuses upgrade. Cloud registration serializes key and registry writes; an app handover reloads ChatGPT auth after its legacy operations drain; public server operations share the ownership gate. App-owned external sessions are published before opening the public listener and unregistered immediately with a generation condition. Successful new starts alone replace the remembered server configuration.
- **Consequences:** Each release needs two platform assets per target and both must pass checksum/version/signature checks. CLI defaults to :6767, the app still requests :1337; separate settings, auth, models and state files prevent one owner's shutdown from affecting the other. The app legacy proxy and its app-core intentionally share only the app token file during their internal handover.
- **Owner:** team.
- **Links:** [PLAN.md](../../PLAN.md), [app-e2e](../app-e2e.md).

Supersedes: [independent core owner and migration contracts](2026-09-15-independent-core-owner-and-migration-contracts.md) for shared app/CLI folder, app detach on full exit and cross-scope settings migration.
