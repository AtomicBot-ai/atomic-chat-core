---
date: 2026-09-15
title: "Sidecar control protocol is HTTP /atomic/v1 + SSE with a stdout ready line"
---

# 2026-09-15 — Sidecar control protocol is HTTP `/atomic/v1` + SSE with a stdout ready line

> Superseded the same day by
> [Independent core owner and migration contracts](2026-09-15-independent-core-owner-and-migration-contracts.md):
> the core is no longer an app-bound sidecar, control and public inference get separate listeners, and
> parent-PID / stdin-EOF liveness is dropped. Kept as the record of the rejected design.

- **Context:** The Tauri app drives the core as a sidecar and needs ~40 control methods (load/unload,
  backends, settings, downloads, events). Two designs were on the table: stdio JSON-RPC, or HTTP control
  routes on the same listener as the OpenAI-compatible server.
- **Decision:** HTTP `/atomic/v1/*` + `GET /atomic/v1/events` (SSE with `Last-Event-ID` replay), on the
  same listener as `/v1`. Stdio carries exactly two things: the first line `{"event":"core:ready",...}`
  and parent liveness (`--parent-pid`, stdin EOF). Control routes require `Bearer <control token>`, accept
  loopback only, and enable CORS only for `tauri://localhost`.
- **Consequences:** One transport serves the app, the CLI-as-client and tests; the Rust supervisor needs
  only `reqwest` and a stdout line reader. Handlers are written as `(input) => Promise<output>` functions
  so a `--transport stdio` variant can be added later without touching them.
- **Owner:** team.
- **Links:** PLAN.md §3.6 (as of the first draft).
