---
date: 2026-09-15
title: "Core is TypeScript on a Node-compatible API, packaged with Bun"
---

# 2026-09-15 — Core is TypeScript on a Node-compatible API, packaged with Bun

- **Context:** The inference logic of Atomic Chat is split between 10k lines of TypeScript policy in a
  WebView extension and ~26k lines of Rust mechanics in Tauri plugins, plus a third copy in the Rust CLI.
  Extracting it into a reusable core required picking one language. The policy already exists in TS; the
  Rust part is thin, well-specified mechanics (spawn, readiness, argv, parsers, downloads).
- **Decision:** The core is TypeScript. All code stays within the Node-compatible API (`node:*` builtins,
  global `fetch`; no `Bun.*`, no native addons). Bun is used only to compile the CLI into a single binary
  (`scripts/build-binaries.mjs`) and to run the e2e suite against that binary.
- **Consequences:** Porting cost is dominated by re-implementing the Rust mechanics (~3k lines of TS) rather
  than rewriting policy. The runtime can be swapped for Node SEA by editing one script. The price is a gate
  in CI (`check-runtime-agnostic.mjs`, eslint restrictions, `types:["node"]`) and a Windows-specific risk
  around process spawning under Bun, retired by `test/runtime-compat` and Windows CI. Hardware probing loses
  NVML/Vulkan bindings; the app injects those facts through the control API.
- **Owner:** team.
- **Links:** PLAN.md §2 decisions 1–2, 10; AGENTS.md §3.6.
