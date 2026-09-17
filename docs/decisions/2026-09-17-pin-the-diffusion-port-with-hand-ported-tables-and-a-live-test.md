---
date: 2026-09-17
title: "Pin the diffusion port with hand-ported test tables and a live test"
---

# 2026-09-17 — Pin the diffusion port with hand-ported test tables and a live test

- **Context:** Earlier ports were pinned by fixtures that the app's Rust emitted (argv, proxy exchanges, settings): as long as both implementations existed, a fixture run on each side caught drift. The diffusion plugin is different. The same migration that makes this core the app's backend deletes the plugin from the app, so there is no second implementation left to drift from, and writing Rust emitters for code that is about to be removed would pin nothing. What can still go wrong is the transcription itself, and upstream stable-diffusion.cpp changing under us.
- **Decision:** Every Rust `#[test]` table of the plugin is ported by hand into the sibling TypeScript test of the module that took over the behaviour, citing the Rust file and the commit it was read at (`767ff6350`). Behaviour that depends on the real engine is covered by `test/live/diffusion.test.ts` (opt-in, `ATOMIC_LIVE=1`): finalize an installed engine, load a model, generate, check step progress, the PNG chunks and the thumbnail, and a hard cancel followed by a respawn. The plugin's list of every flag it passes to `sd-server` moves to `test/fixtures/sdcpp/required-flags.txt`; a unit test holds `args.ts` to that list, and the live test holds the list to the pinned binary's `--help`, so a flag renamed upstream fails before it ships.
- **Consequences:** No Rust fixture emitters for diffusion. The live test needs an engine and a model on the machine and is not part of `npm run verify`; the in-process fake `sd-server` carries the job state machine in CI.
- **Owner:** team.
- **Links:** `src/diffusion/*.test.ts`, `test/fixtures/sdcpp/required-flags.txt`, `test/live/diffusion.test.ts`; app source `src-tauri/plugins/tauri-plugin-atomic-diffusion/src/` and `scripts/test-local-diffusion.py` at `767ff6350`.
