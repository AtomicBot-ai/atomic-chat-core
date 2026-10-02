---
date: 2026-10-02
title: "tensorrt-llm: what the Windows live acceptance changed — a bare wsl --install, launch bounds for small cards, Qwen3.5 answers in content"
---

# 2026-10-02 — tensorrt-llm: what the Windows live acceptance changed — a bare wsl --install, launch bounds for small cards, Qwen3.5 answers in content

- **Context:** The Windows live acceptance of change `add-tensorrt-llm-windows` ran on Windows 11 with an
  RTX 4070 Laptop (8 GB, compute capability 8.9) and TensorRT-LLM 1.3.0rc29. It found four failures the
  design did not foresee:
  1. On a Windows without WSL, `wsl.exe` is a built-in stub. It takes only a bare `wsl --install`, and it
     answers "not installed" without a console. It refuses `--install --no-distribution` (record
     `2026-10-01-tensorrt-llm-on-windows-runs-in-atomic-chats-own-wsl-distribution.md`, D2) and `--update`.
     Right after the install, `wsl --status` succeeds although WSL cannot run until a restart.
  2. Qwen3.5-2B (hybrid, Mamba layers) failed to start on 8 GB: "The V2 Mamba GPU cache quota is too
     small … need at least 20696801280 bytes". `trtllm-serve` defaults `max_batch_size` to 2048, and the
     recurrent state is reserved for every one of those sequences. With a smaller batch it then refused
     "Quota not set. Check kv_cache_config.max_tokens". CUDA graphs took about 2 GB of the 8.
  3. With thinking off, the `qwen3_5` reasoning parser assumes every reply starts inside `<think>`. It
     filed the whole answer under `reasoning_content` and left `content` empty.
  4. The entrypoint script, mounted from NTFS through 9p, has no execute bit:
     `exec /atomic/entrypoint.sh: permission denied`.
- **Decision:** (owner, during the acceptance)
  1. `windows.enable-wsl` runs a bare `wsl --install` with an inherited hidden console, then `wsl --status`.
     Windows installs Ubuntu alongside, and the core never uses it. WSL counts as ready only when the
     component-servicing `RebootPending` key is absent. While it is present, the plan carries the blocker
     `windows-restart-pending` and offers no new `enable-wsl`.
  2. The launch passes `--max_batch_size` (setting `max_batch_size`, default 8, 1–256), and always bounds
     the KV cache in tokens: `kv_cache_max_tokens` when set, otherwise `context_length × max_batch_size`.
     A unified-memory card keeps `context_length × 2` (record
     `2026-09-29-tensorrt-llm-unified-memory-kv-cache-bounded-by-tokens.md`). The fraction flag stays,
     and the engine takes the smaller bound.
     - `cuda_graphs` (`auto`/`on`/`off`): under `auto`, CUDA graphs are off (`cuda_graph_config: null`) on a
       card that reports less than 12 GiB, and stay on for a card that reports no size (unified memory).
     - `kv_cache_dtype: fp8` applies only at compute capability 8.9 or newer.
     - All four settings are in the restart key.
  3. The adapter declares `rewriteResponseFor`. For a reasoning-at-start parser (`qwen3_5`) and a chat
     request without `enable_thinking: true`, the session gateway moves `reasoning_content` into `content`,
     in a whole JSON answer and in each SSE event (decoded with a `StringDecoder`).
  4. The container's entrypoint is `/bin/sh`, with the script path as its first argument, on every
     platform.
- **Consequences:** Supersedes D2's `--no-distribution` in the 2026-10-01 Windows record, and the
  "discrete card: the fraction alone" half of the 2026-09-29 unified-memory record. More than 8
  concurrent requests queue in the engine. On a large card, the KV cache can be smaller than the
  fraction alone would give, if `context × 8` is below it; raise "Parallel Requests" or "KV Cache Token
  Limit" then. A person who installs TensorRT-LLM on a machine without WSL also gets Ubuntu. Another
  update that sets `RebootPending` makes the setup ask for the restart Windows is waiting for anyway.
- **Owner:** `team`
- **Links:** `src/host/recipes/enable-wsl.ts`, `src/host/recipes/executor*.ts`,
  `src/runtime/environment/windows-{probe,plan,provisioner}.ts`, `src/runtime/tensorrt-llm/adapter.ts`,
  `src/runtime/managed-text/gateway.ts`, `src/runtime/container/argv.ts`; atomic-chat-spec
  `openspec/changes/add-tensorrt-llm-windows/rulings/core.md` ("Живая приёмка").

<!--
Supersedes: 2026-10-01-tensorrt-llm-on-windows-runs-in-atomic-chats-own-wsl-distribution.md (D2 only); 2026-09-29-tensorrt-llm-unified-memory-kv-cache-bounded-by-tokens.md (discrete-card half only)
-->
