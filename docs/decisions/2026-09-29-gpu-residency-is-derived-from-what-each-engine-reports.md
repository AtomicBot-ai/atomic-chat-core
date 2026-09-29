---
date: 2026-09-29
title: "GPU residency is derived from what each engine reports, and GPU_BUSY names what would not stop"
---

# 2026-09-29 — GPU residency is derived from what each engine reports, and GPU_BUSY names what would not stop

- **Context:** Task 2.15 (spec `gpu-residency`, design D10): one resident local model per card across
  llama.cpp (both providers), MLX, image generation and `tensorrt-llm`, with every stop confirmed
  before the next start, and the reservation kept — the next load refused with `GPU_BUSY` — while a
  stop is not confirmed. Every engine already stopped its *own* models before a load; none knew the
  others. Task 2.2 had ported `core/gpu/policy.ts` from `feat/tenzor-rt`: a stateful `ResidencyPolicy`
  ledger keyed by one card id, with `reserve`/`markStarted`/`confirmStopped(proof)`. Nothing called it.
- **Decision:**
  1. **No ledger; the engines' own tables are the reservations.** Each runtime reports what it holds
     through `LocalRuntime.gpuOccupancy()` (`runtime/shared/gpu-occupancy.ts`): per session
     `{ model_id, cards, auxiliary, state }`. A session stays listed until its engine has *verified*
     it gone — a llama.cpp/MLX session is dropped only when its process exited, a managed-text entry
     stays `stopping`/`stop-unconfirmed` until Docker confirmed exit or absence, an `sd-server` until
     its process exited. The ported ledger is replaced (`policy.ts` is now pure functions over those
     reports): a second copy of "who holds the card" drifts the moment a process dies on its own or a
     crash-watcher and the ledger disagree, and a stale reservation is a card no load can ever get.
  2. **How each engine reports its cards.** llama.cpp: `'all'` for a GPU build, `[]` only for a build
     whose id positively says CPU (`-cpu`, an AVX tier, `common_cpus`, a bare `linux-x64`/`win-x64`
     build); macOS builds and unknown ids (a CLI `--bin`) count as GPU — calling a GPU session
     CPU-only would let a second engine onto an occupied card. MLX: `'all'`. Image generation: `'all'`,
     `[]` on the CPU backend or after its CPU-fallback restart. `tensorrt-llm`: `[gpu_uuid]` of the
     container. Embedding sessions and the transcription model (`TRANSCRIPTION_MODEL_ID`, now passed to
     both llama.cpp runtimes, the exemption `autoUnloadTargets` already had) are `auxiliary`: never
     evicted, never evicting, never refused. Foundation Models reports nothing (system-managed).
     Containers a previous core left that startup reconcile could not confirm stopped hold `'all'` (the
     journal does not record their card); evicting one re-runs the reconcile.
  3. **When a load asks.** Each runtime calls its `claimGpu` hook once it knows what it will take and
     before it starts anything: llama.cpp after planning (the backend is resolved), MLX right before the
     spawn, image generation before every `sd-server` spawn (load and job respawn), `tensorrt-llm` as
     the lifecycle's `stopping-previous` stage with the card it chose. A load is reported as `loading`
     only after its claim resolved. `core/gpu/residency.ts` takes GPU claims one at a time; so of two
     racing loads the later claim sees the earlier one and stops it — the model asked for last stays.
  4. **How core stops an occupant, in its own scope only.** A local session through the facade's
     `unload` (`LocalSessions`), cancelling its load first when it is still loading — so the
     cross-process model claim is released exactly when a client's unload would release it, and never
     over a live process or an unconfirmed container (carry-forward 2.14: `stopOthers` used to unload
     beneath `LocalSessions` and leak the claim). The image model through `DiffusionService.unloadModel`,
     which also aborts a claim still waiting under its load lock. Sessions of another core scope and
     sessions another process registered are never listed, so never stopped.
  5. **`GPU_BUSY` semantics.** After the evictions the policy is run again over fresh reports; anything
     still there refuses the load with `GPU_BUSY`, message `<provider>/<model_id> still holds the GPU…`
     and details `holder=<provider>/<model_id> state=<state> cards=<ids|all> cause=<why the stop
     failed>` (the engine's own details, e.g. Docker's answer). A timeout, a dropped connection or a
     killed docker client never counts as a stop, because the engine keeps the session listed. The
     next load tries to stop it again; the card is released only on confirmation.
  6. **Within a provider nothing changes:** llama.cpp and MLX keep their own `auto_unload` for their own
     models (`bypassAutoUnload` still skips only that); `tensorrt-llm`'s one-session limit is the
     claim's `soleSessionOfProvider`, a runtime limit rather than a residency rule (D10).
- **Consequences:** Loading any GPU model now stops other engines' GPU models in this scope — including
  `llamacpp` vs `llamacpp-upstream` and MLX vs llama.cpp on macOS, which previously coexisted. A container
  left unconfirmed by a previous core blocks every GPU load until Docker confirms it gone (conservative:
  its card is unknown). Image generation surfaces `GPU_BUSY` through its own error surface as `INTERNAL`
  with `GPU_BUSY: …` in the details, because `GPU_BUSY` is not in `DIFFUSION_ERROR_CODES` (adding it is an
  app-contract change). A llama.cpp context-growth reload does not go through `LocalSessions`, so a
  residency eviction cannot cancel it while it starts; the claim that finds it still starting refuses
  with `GPU_BUSY` rather than letting two engines share the card. Not covered here: the spec's
  out-of-memory error "with measured numbers" when another scope's model holds the card.
- **Owner:** `team`.
- **Links:** `src/core/gpu/policy.ts`, `src/core/gpu/residency.ts`, `src/core/gpu-residency.ts`,
  `src/runtime/shared/gpu-occupancy.ts`, `src/core/tensorrt-llm.ts` (`leftoverContainers`),
  `test/e2e/gpu-residency.test.ts`; spec `openspec/changes/add-tensorrt-llm-linux/specs/gpu-residency/spec.md`,
  design D10.

<!--
Supersedes: the stateful `ResidencyPolicy` ported by task 2.2 (no ADR of its own; see
2026-09-28-port-managed-runtime-contracts-selectively-from-feat-tenzor-rt.md)
-->
