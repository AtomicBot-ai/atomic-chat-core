---
date: 2026-09-17
title: "spawnManaged reports raw chunks and can skip capturing output"
---

# 2026-09-17 — spawnManaged reports raw chunks and can skip capturing output

- **Context:** `spawnManaged` hands a caller complete lines (through `node:readline`) and keeps everything a process ever wrote, so a startup failure can be classified from the whole output. Both are wrong for `sd-server`. stable-diffusion.cpp redraws its step bar in place: every redraw is `\r<bar> <step>/<steps> - <speed>ESC[K`, with a newline only on the last step. The carriage return *leads* the next redraw, so a reader keyed on line ends delivers each step one redraw late (measured the same under Node and Bun), and with several seconds per step the progress bar the user sees is always one step behind. And the server is run with `-v` for hours at a time: keeping its whole output is an unbounded buffer in a process meant to stay up.
- **Decision:** Two additive hooks, in a third optional argument so no existing caller changes: `onData(stream, chunk)` with the raw bytes as they arrive, before any line splitting, and `captureOutput: false`, which stops the accumulation (`output()` then stays empty). The diffusion module splits records itself (`\r`, `\n`, `\r\n`, or a trailing `ESC[K`) and keeps its own 200-line tail. With no `onLine` and no capture, no readline interface is created at all. A planned third hook, `onSpawn`, was dropped: `spawnManaged` returns synchronously with the pid, so a caller that needs to journal the child before it is ready (a model load takes minutes, and a crash in that window would orphan a multi-gigabyte process) calls `spawnManaged` directly and runs its own readiness loop, which `sd-server` needs anyway (no ready marker, `GET /v1/models` answering 200 is the signal).
- **Consequences:** The llama.cpp, MLX and Foundation Models paths are untouched: they pass no hooks. A caller that turns capture off owns its diagnostics.
- **Owner:** team.
- **Links:** `src/runtime/shared/process.ts`, `src/diffusion/progress.ts`; app source `src-tauri/plugins/tauri-plugin-atomic-diffusion/src/{process,progress}.rs` at `767ff6350`.
