---
date: 2026-09-28
title: "Bump core to 0.7.0 for the TensorRT-LLM descriptor gate"
---

# 2026-09-28 — Bump core to 0.7.0 for the TensorRT-LLM descriptor gate

- **Context:** The published TensorRT-LLM runtime descriptor (`atomic-chat-conf/runtimes/tensorrt-llm.json`
  on the conf branch for this change, and the verbatim fixture `test/fixtures/runtimes/tensorrt-llm.json`,
  task 2.1) carries `"minimum_core_version": "0.7.0"`. Task 2.3's descriptor provider (spec
  `runtime-descriptor-catalog`, "Минимальные версии соблюдаются") accepts a fetched descriptor only
  when its `minimum_core_version` is no higher than this build's own `CORE_VERSION` (`src/version.ts`,
  kept in sync with `package.json` by `src/version.test.ts`). At `CORE_VERSION` `0.6.0` the descriptor
  would always be refused, including through the `file://` override the dev flow
  (`ATOMIC_RUNTIME_DESCRIPTOR_URL=file://…/atomic-chat-conf/runtimes/tensorrt-llm.json`, brief §2.3
  preamble) is supposed to exercise before conf's branch merges to its own `main`.
- **Decision:** Bump `CORE_VERSION` and `package.json` `"version"` to `0.7.0` on this branch now, in
  its own commit ahead of the descriptor-provider work, rather than waiting for the change's release
  task (2.20). 2.20 does not bump again — this commit already identifies the branch as core 0.7.0 for
  the whole change. Tests that pinned the literal string `"0.6.0"` as *this build's own version* are
  updated to `"0.7.0"`; tests that pin `"0.6.0"` as a fixture or a historical release record are left
  alone (none were found pinning `CORE_VERSION` outside `src/version.ts`/`src/version.test.ts` at the
  time of this change).
- **Consequences:** Every later task on this branch runs as core 0.7.0. If this branch needs to merge
  behind another 0.6.x patch release of `main` before this change ships, the two version bumps need
  reconciling by hand; that risk is accepted because the alternative — gating the descriptor on a
  version this build cannot yet claim — blocks task 2.3's own acceptance tests and the dev-only
  `file://` flow.
- **Owner:** `team`
- **Links:** openspec change `add-tensorrt-llm-linux`, task 2.3; `src/version.ts`; `package.json`;
  `test/fixtures/runtimes/tensorrt-llm.json`; `src/runtime/environment/descriptor-provider.ts`.
