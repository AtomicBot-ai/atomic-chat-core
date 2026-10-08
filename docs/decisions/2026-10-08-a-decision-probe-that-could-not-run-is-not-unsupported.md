---
date: 2026-10-08
title: "A decision engine probe that could not run is not an unsupported engine"
---

# 2026-10-08 — A decision engine probe that could not run is not an unsupported engine

- **Context:** the decision engine gate (ADR 2026-09-30-the-decision-model-is-its-own-core-module) runs
  `llama-server -h` on each installed TurboQuant pack and takes the first whose help lists `--decision`.
  A probe that failed (the 5 s budget of the llama.cpp runtime's `checkSpecTypeSupport` ran out, the
  process could not start) was folded into the list of builds that do not serve the model, and the start
  ended in `DECISION_ENGINE_UNSUPPORTED`, state `unsupported`, "Install TurboQuant 1.7.0 or newer". On
  2026-10-08 (ATO-542, core 0.11.2, TurboQuant b10298-2.0.0 on macOS) Laya failed that way although the
  build lists `--decision`: the probe timed out, and a retry of the unchanged settings was ready in 1.2 s.
  The app then offered an install that could not help. A `-h` that ended in a crash (a library that would
  not load) also printed no help, and counted as "does not list the flag" the same way.
- **Decision:** only a finished help screen is evidence. The default probe runs `-h` through `runHelp`
  (`src/runtime/llamacpp/probe.ts`) with a 30 s budget (`DECISION_PROBE_TIMEOUT_MS`; the answer is
  remembered per file, so a slow first run after an install is paid once), and a `-h` that exits other
  than 0 without the flag rejects as `MODEL_LOAD_FAILED` with its exit, duration and the end of its output.
  When no build passes and one of them could not be checked, `resolve` fails with the probe's own code
  (`MODEL_LOAD_TIMED_OUT` or `MODEL_LOAD_FAILED`), message "Could not check whether the installed engine
  serves the decision model: …" and every build tried in the details; the module is `failed`, and a
  `load` (the app's Retry) checks again, since a probe that could not run is never remembered.
  `DECISION_ENGINE_UNSUPPORTED` is left to builds that were checked: no flag in a finished help, refused at
  readiness, missing file. A lower build that passes still runs when a higher one could not be checked.
- **Consequences:** a slow or crashed probe no longer sends the user after an engine they have, and the
  app can tell a retry from an install by the code alone. The cost: a hung `-h` holds a start for up to
  30 s instead of 5 s before it fails. The llama.cpp runtime's `draft-dflash` probe keeps its 5 s and its
  "not listed" reading of any output. The app (Atomic-Chat ATO-542) also reads an older core's
  `DECISION_ENGINE_UNSUPPORTED` whose details are all `probe failed` as a retry.
- **Owner:** `team`.
- **Links:** Linear ATO-542 (and ATO-543 for the app's update message); `src/decision/engine.ts`,
  `src/runtime/llamacpp/probe.ts`, `src/decision/engine.test.ts`, `src/decision/service.test.ts`.
