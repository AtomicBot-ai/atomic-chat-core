---
date: 2026-10-01
title: "Bump core to 0.7.5 after merging main's 0.7.1-0.7.4"
---

# 2026-10-01 — Bump core to 0.7.5 after merging main's 0.7.1-0.7.4

- **Context:** The 2026-09-28 record identified this branch as core `0.7.0` and accepted that a merge
  behind later releases of `main` would need the versions reconciled by hand. That happened: `main`
  released `v0.7.0` (control protocol 1) and then `v0.7.1`-`v0.7.4`, and merging it took `main`'s
  `0.7.4`. Both names belong to releases on protocol 1, while this branch speaks control protocol 2.
  The app pins the core by exact version, so an app on this branch that fetches its pin
  (`yarn download:core` without local binaries) gets the released protocol-1 core and refuses it with
  `CORE_PROTOCOL_MISMATCH`.
- **Decision:** Bump `CORE_VERSION` and `package.json` `"version"` to `0.7.5`, a version no release
  carries yet, and pin the app branch to the same. Supersedes the version half of the 2026-09-28
  record; its descriptor-gate reasoning stands (`minimum_core_version` `0.7.0` is below `0.7.5`).
- **Consequences:** A build of this branch no longer shares a version with a released core. If `main`
  releases its own `0.7.5` before this change ships, the versions collide again and need the same
  reconciliation, this time at the next free version.
- **Owner:** `team`
- **Links:** openspec change `add-tensorrt-llm-linux`;
  [2026-09-28 record](2026-09-28-bump-core-to-0-7-0-for-the-tensorrt-llm-descriptor-gate.md);
  `src/version.ts`; `package.json`; app `package.json` `atomicCore.version`.
