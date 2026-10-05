---
date: 2026-10-02
title: "Bump core to 0.9.2 after merging main's 0.8.0-0.9.1"
---

# 2026-10-02 — Bump core to 0.9.2 after merging main's 0.8.0-0.9.1

- **Context:** This branch (changes `add-tensorrt-llm-linux` and `add-tensorrt-llm-windows`) was
  core `0.7.6`. Meanwhile `main` released `v0.8.0`, `v0.9.0` and `v0.9.1`, none of which carries
  TensorRT-LLM or reads conf `runtimes/`. Merging `main` puts both versions in conflict. Taking
  `main`'s `0.9.1` would name this branch after a release it is not. The app pins the core by exact
  version, so an app on this branch that fetches its pin (`yarn download:core` without local
  binaries) would get the released core with no TensorRT-LLM.
- **Decision:** Bump `CORE_VERSION` and `package.json` `"version"` to `0.9.2`, a version no release
  carries yet, and pin the app branch to the same. This is the same reconciliation as the
  2026-10-01 record. The conf gates stand: descriptor `minimum_core_version` `0.7.6` and environment
  manifests `0.7.5` are below `0.9.2`. Released cores `0.8.0`–`0.9.1` never fetch `runtimes/`, so
  they never meet those documents.
- **Consequences:** If `main` releases its own `0.9.2` before this branch ships, the versions collide
  again and need the same reconciliation at the next free version.
- **Owner:** `team`
- **Links:** [2026-10-01 record](2026-10-01-bump-core-to-0-7-5-after-merging-main.md); `src/version.ts`;
  `package.json`; app `package.json` `atomicCore.version`.

<!--
Supersedes: 2026-10-01-bump-core-to-0-7-5-after-merging-main.md (version only)
-->
