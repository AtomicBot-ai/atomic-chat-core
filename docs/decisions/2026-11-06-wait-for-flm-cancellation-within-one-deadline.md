---
date: 2026-11-06
title: "Wait for FLM cancellation within one deadline"
---

# 2026-11-06 — Wait for FLM cancellation within one deadline

- **Context:** Closing a chat socket does not synchronously release FLM's NPU lock. The cancellation acknowledgement request can receive HTTP 503 before the native disconnect handler releases it. Treating that response as a failed cancellation killed a healthy worker and broke the next queued request.
- **Decision:** Keep the generation queue held and retry a busy acknowledgement every 50 ms within the existing single three-second deadline. Only the exact local-only `invalid_local_request` rejection confirms the lock is free. Other responses, transport failures and deadline expiry still terminate the owned worker. Do not retry user generations or extend the deadline per attempt.
- **Consequences:** Immediate follow-up requests wait for the real cancellation acknowledgement. A deterministic fake worker delays lock release by 200 ms; streaming, non-streaming and queue cancellation regressions fail without this fix. A separate hung-worker test preserves the bounded termination behavior.
- **Owner:** team.
- **Links:** `src/runtime/fastflowlm/runtime.ts`, `src/runtime/fastflowlm/runtime.test.ts`, `test/helpers/fake-fastflowlm.mjs`.
