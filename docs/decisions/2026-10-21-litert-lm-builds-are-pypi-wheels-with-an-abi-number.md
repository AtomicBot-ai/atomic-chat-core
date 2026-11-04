---
date: 2026-10-21
title: "LiteRT-LM builds are Google's PyPI wheels, gated by our own ABI number"
---

# 2026-10-21 — LiteRT-LM builds are Google's PyPI wheels, gated by our own ABI number

- **Context:** LiteRT-LM's GitHub releases carry no desktop libraries since v0.12; the `litert-lm-api` wheels on PyPI do, one per platform (macOS 12+ arm64, manylinux 2.27 x86_64/aarch64, Windows x64), and Google changed the C functions inside a minor version (0.18.1 was an ABI fix). PyPI paths carry hash folders a version cannot predict. Change `add-litert-lm-runtime`, design D2.
- **Decision:** conf's `backends/litert-lm-manifest.json` lists releases with an explicit wheel URL on `files.pythonhosted.org` (nothing else is accepted), `size` and `sha256` per platform, `min_core_version`, an optional `openvino` wheel for Windows NPU, and `abi` — a number of ours that moves when the functions `ffi-bun.ts` binds change. The core installs only releases whose `abi` it binds (`SUPPORTED_LITERT_LM_ABI = [1]`); a wheel unpacks as a zip and only the native part of `litert_lm/` stays, under `<build>/lib/`; `litert-host probe` checks it before the swap. The active build is the newest by `published_at` among installed builds with a supported ABI.
- **Consequences:** no mirror and no release pipeline of our own; the sha256 in conf pins Google's file. A new Google release with changed signatures needs a core release and a new `abi` before conf may list it; old cores keep the last release they bind. PyPI forbids re-uploading a file name but not deleting one: a deleted wheel leaves installed builds working, and its release leaves the manifest.
- **Owner:** `team`.
- **Links:** `src/engine-builds/{manifest,litert-lm,engines}.ts`, `atomic-chat-conf` `backends/litert-lm-*.json`.
