---
date: 2026-11-23
title: "Compact overflowing chat history on every engine"
---

# 2026-11-23 — Compact overflowing chat history on every engine

- **Context:** When a chat outgrew the window of a local model, the only remedy was to grow the
  window. Growth reloads the model at a larger context. It is declined under fit, which is
  llama.cpp's default. Engines that have a route policy (vLLM, SGLang, TensorRT-LLM, Strata,
  FastFlowLM, GenieX, LiteRT-LM, Foundry Local) were never grown: they returned the error and
  never retried. Restarting them with a larger window takes minutes. No part of the core or the
  app summarized history. Users saw a long loader or a dead end, and clients of `:1337` saw an
  error.
- **Decision:** A request that does not fit its session's window is compacted. The oldest turns
  are summarized by the same loaded model, and the request goes on without a reload. One rule
  decides between growing and compacting, `decideOverflowAction` in `src/contracts/context.ts`,
  and the app uses the same rule. A window grows only on an engine that reloads in seconds
  (`reload`: llama.cpp family, MLX) and only while it is below the device maximum that would
  hold the request. Every other overflow is compacted.
  - **Module.** `src/server/compaction/` does the work. It is used by the control routes
    `POST /models/:p/*m/context/measure` and `…/compact`, which the app's chat calls, and by the
    public server for `/v1/chat/completions`.
  - **On the public server**, compaction runs at three points:
    - before sending, when the counted prompt plus the answer reserve passes
      `CONTEXT_FIT_RATIO` (0.9) of the window;
    - after an engine overflow error;
    - after a non-streamed `finish_reason: length` at the window.

    Non-policy sessions keep today's growth first. A compacted answer carries
    `x-atomic-compacted`, and a client opts out with `x-atomic-compaction: off`.
  - **Not compacted:** `/v1/messages` and `/responses`. Claude Code and Codex compact their own
    history, so they get the engine's overflow instead (see the companion ADR).
  - **Where the summary goes.** It is a `<conversation_summary>` block appended to the system
    prompt. Strict templates that require user and assistant turns to alternate stay valid.
  - **Where history is cut.** Only at a user turn. A tool call is never split from its results.
    After compaction the prompt aims at `COMPACTION_TARGET_RATIO` (0.5) of the window, so
    compaction stays rare and the prompt cache stays warm afterwards.
  - **Summarizing.** One non-streamed request to the same session, with thinking off. It is
    capped at a tenth of the window, between 256 and 2048 tokens. History over 60% of the window
    is summarized in rolling chunks, at most 12 calls.
  - **Summary cache.** An in-memory LRU of 256 entries, keyed by chained sha256 prefixes. A
    client that resends its whole history is not summarized again, and later compactions only
    add the new turns.
  - **Counting.** Exact where the engine can count:
    - llama.cpp: `/apply-template` + `/tokenize`;
    - vLLM and SGLang: their `/tokenize`, declared on the gateway but never forwarded by the
      public server.

    Elsewhere the app's heuristic is used, calibrated per session from `usage.prompt_tokens`
    and widened by 10% until the session has reported usage.
- **Consequences:**
  - Overflowing chats keep going on every engine the public server routes, with no reload.
  - MLX's served window is now known (`LocalTarget.contextLength`).
  - **Cost:** a summary takes one model call of a few seconds, more on single-slot engines,
    which queue it. A 1–2B model writes weak summaries; the app shows the summary and keeps the
    drop-oldest-turns trim as a fallback.
  - **Where only the estimate applies:** MLX, TensorRT-LLM, Strata, FastFlowLM, GenieX,
    LiteRT-LM, Foundry Local and Apple Foundation Models. They have no exact count. Engines
    without a known window are compacted only after an overflow.
  - **Foundation Models** is measured but not compacted by the core: it declares no window.
  - **Calibration on streams** learns only when the client asked for usage.
  - **Follow-ups:**
    - show compaction on the request trace;
    - add `x-atomic-compacted` to CORS expose-headers.
- **Owner:** `team`.
- **Links:**
  - Code: `src/contracts/context.ts`, `src/server/compaction/`, `src/server/public/forward.ts`,
    `src/server/control/routes/models.ts`, `test/e2e/compaction.test.ts`.
  - ADRs: `2026-11-03-serve-coding-agents-with-their-window-and-bounded-output.md`,
    `2026-11-23-map-every-engines-context-overflow-to-one-error.md`.
