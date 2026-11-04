---
date: 2026-11-02
title: "Wait for audio lifecycle cleanup and reject superseded jobs"
---

# 2026-11-02 — Wait for audio lifecycle cleanup and reject superseded jobs

- **Context:** audio cancellation can finish its job before its server teardown finishes. A replacement session could be marked unloaded by that older teardown. Shutdown aborted a pending load without waiting for the spawned child to exit, and a job reading a reference WAV could silently use a replacement model.
- **Decision:** shutdown aborts pending work first, then acquires the audio load lock and waits for child and journal cleanup. A teardown remains in `stopping` through journal removal. Internal model generations let loads and unloads supersede an older teardown's state changes without making cancellation reacquire the load lock. After reference audio is read, job submission checks shutdown and the identity of the selected model again before registering or sending anything.
- **Consequences:** shutdown and replacement loads wait for cleanup already in flight. A reference read overtaken by a model switch returns `CANCELLED`; one overtaken by shutdown returns `ENGINE_CRASHED`, matching submissions made during shutdown. The wire shapes, engine selection, model downloads and audio.cpp protocol are unchanged. Generation checks are internal to the audio service.
- **Owner:** `team`.
- **Links:** `src/audio/{service,session,jobs,state}.ts`, their sibling tests, `test/e2e/audio.test.ts`, PR #61.
