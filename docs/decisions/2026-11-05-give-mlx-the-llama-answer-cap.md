---
date: 2026-11-05
title: "Give mlx-server the llama.cpp answer cap"
---

# 2026-11-05 — Give mlx-server the llama.cpp answer cap

- **Context:** Atomic-Chat#384: an MLX reply ended at 2048 tokens with `finish_reason: length`, and the
  reporter only got further by setting `MLX_VLM_MAX_TOKENS=8192` in the macOS environment. mlx-server
  reads that variable as the cap for a request that sends no `max_tokens`, and defaults it to 2048. Core
  started mlx-server without it, while llama.cpp loads get `--n-predict` `DEFAULT_N_PREDICT` (16384,
  never above the window). The app now sends its own `max_tokens` to MLX, but every other client of the
  public API (agents, third-party tools) still got 2048. Worse, `isContextOverflowFinishLength` assumes
  the 16384 engine cap, so a non-streamed MLX answer cut at 2048 read as a context overflow: core reloaded
  the model at a doubled context, generated again and returned the same cut answer.
- **Decision:** `MlxRuntime` starts mlx-server with `MLX_VLM_MAX_TOKENS` set to
  `resolveNPredict(0, ctx_size)` — 16384, or the window when it is smaller — unless the environment
  already sets a non-empty value, which stays as the user's own cap. A client's `max_tokens` still wins
  per request.
- **Consequences:** MLX and llama.cpp end an answer that sends no cap at the same length, and the
  finish-length check's engine cap is right for MLX too, so a long non-streamed answer no longer reloads
  the model. A runaway MLX generation now runs up to 16384 tokens instead of 2048. A user who sets the
  variable lower than 16384 can still see a non-streamed answer at that cap treated as an overflow, as
  with a user-set llama.cpp `n_predict`.
- **Owner:** team.
- **Links:** <https://github.com/AtomicBot-ai/Atomic-Chat/issues/384>; `src/runtime/mlx/runtime.ts` and its
  test; `src/runtime/llamacpp/generation-limits.ts` (`resolveNPredict`); `src/server/public/errors.ts`
  (`isContextOverflowFinishLength`).
