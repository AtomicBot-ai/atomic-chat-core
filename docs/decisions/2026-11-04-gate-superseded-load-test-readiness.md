---
date: 2026-11-04
title: "Gate superseded-load test readiness on cancellation"
---

# 2026-11-04 — Gate superseded-load test readiness on cancellation

- **Context:** Waiting for the first managed load to register removed one timing race, but opening the shared fake readiness gate before the second load finishes its filesystem reads still lets the first load succeed instead of being cancelled.
- **Decision:** Keep the first load unready and give it an unreachable fake-clock deadline. Open readiness only after that load rejects with MODEL_LOAD_CANCELLED. Bound registration by four seconds of wall time rather than a number of event-loop turns.
- **Consequences:** The second model's stop is the only successful way to end the first load in this test. Production load behavior is unchanged; a missing registration or cancellation still fails the test rather than timing out into a false pass.
- **Owner:** `team`.
- **Links:** PR #41, `src/runtime/managed-engines/runtime.test.ts`.
