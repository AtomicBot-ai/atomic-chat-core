---
date: 2026-09-29
title: "GPU residency holds stopping sessions until exit, grants inside the turn, and names a remedy"
---

# 2026-09-29 — GPU residency holds stopping sessions until exit, grants inside the turn, and names a remedy

Amends `2026-09-29-gpu-residency-is-derived-from-what-each-engine-reports.md` (task 2.15 review r1).
Where the two disagree, this record is the accurate one.

- **Context:** The review found several problems with the first record.
  - Its item 1 ("a llama.cpp/MLX session is dropped only when its process exited", "an `sd-server`
    until its process exited") was false. llama.cpp's `unloadSession`, `SidecarTable` (MLX) and
    diffusion's `takeDownSession` all took the session out of their table *before* awaiting the
    terminate. So a claim during any stop begun elsewhere saw a free card. That covers a client unload,
    diffusion's idle unload, a context-growth reload, and llama.cpp's own auto-unload.
  - It also found a deadlock. A residency eviction of image generation could arrive while a diffusion
    load or respawn held the diffusion load lock but had not yet created its abort controller. The
    unload then waited for the lock, while the load's claim waited for the unload.
  - The GPU settle delay ran before the claim, not after the eviction it is meant to follow.
  - A load was registered as `loading` by a microtask after its claim resolved, not inside the claim's
    turn.
  - Its "Not covered" note on out-of-memory numbers was inaccurate.
- **Decision:**
  1. **A session is listed until its process exited.**
     - llama.cpp keeps each session it is stopping in a `stopping` map. `SidecarTable` keeps it in
       `terminating`, exposed as `stopping()`. Diffusion keeps `state.stopping = { spec, done }`.
     - Each is reported `state: 'stopping'` until the terminate resolves. The terminate resolves only
       on the child's `exit`, after SIGKILL if the grace ran out.
     - A second unload joins the same stop: llama.cpp's joined promise, the sidecar's existing
       `unloading` map, or diffusion's `unloadModel`, which waits for `state.stopping.done` even for a
       takedown begun outside its lock (a job's crash or cancel). So an eviction of a stopping occupant
       returns only once it has exited.
     - A failed stop keeps the process as the session. llama.cpp and the sidecar already did this;
       diffusion now does too, when the server has not exited.
  2. **No claim can wait on an unload that waits on it.**
     - A diffusion load creates its abort controller as the first statement inside the load lock.
     - `unloadModel` counts itself as pending from the moment it is called until its locked work ends.
       A GPU claim that starts while an unload is pending gives up at once. That covers a load or a
       respawn that held the lock before the unload asked.
     - The count is decremented inside the lock, so a load queued behind the unload is never taken for
       superseded.
     - Core's residency races every eviction with the claimant's own signal. A cancelled load stops
       waiting for a stop (the stop goes on) and hands the turn on.
  3. **Diffusion claims first, then settles.** The `GPU_SETTLE_MS` wait now follows the exit of
     whatever the claim evicted.
  4. **A load is registered inside core's turn.** `GpuClaimHook` takes a third argument, `granted`.
     Core calls it synchronously once the claim has succeeded, before the turn is released: at once for
     a CPU-only or auxiliary load, never for a refused one. Each runtime registers its load as `loading`
     there, so the next claim always sees it.
     - The runtimes also register after the awaited hook, idempotently, for a hook that does not grant.
     - `tensorrt-llm` receives its reservation's generation from the lifecycle
       (`stopPrevious(signal, generation)`) rather than looking it up. Its `gpuOccupancy()` is a pure
       read; forgetting dead generations happens when a claim starts.
  5. **`GPU_BUSY` names a remedy.** The message ends with the occupant's own `remedy`, or "Try again
     once it has stopped." Remedies:
     - A leftover container from a previous core: "Start Docker, or remove container `<id>` yourself
       (`docker rm -f <id>`); the next load retries the stop."
     - A `tensorrt-llm` container whose stop Docker did not confirm: "Loading again retries the stop;
       if Docker keeps failing, restart Docker or remove container `<id>`."
     - The details keep `holder=… state=… cards=… cause=…`.

     A leftover container's retried reconcile is bounded like the startup one: 10 s per docker call,
     `docker stop --time 5`, and a 20 s total budget.
  6. **Out-of-memory, accurately.** Core never stops another scope's sessions. Occupants come only from
     this core's runtimes, its image-generation service and this data folder's execution journal.
     Sessions another process registered as external are never occupants; a test covers the app core
     loading while the CLI core holds a model. When the card is too full because another scope holds
     it:
     - a `tensorrt-llm` load fails with the adapter's out-of-memory classification, which carries the
       numbers from the engine log (`requested_gib`, `free_gib`);
     - a llama.cpp load fails with `OUT_OF_MEMORY` and a fixed message, with no measured numbers.
       Adding numbers there is not part of this task.
  7. The replacement of the ported stateful `ResidencyPolicy` by pure functions plus the FIFO
     coordinator stands (review ruling). Image generation keeps reporting `GPU_BUSY` as `INTERNAL` with
     `GPU_BUSY: holder=…` in the details. A diffusion error code would be an app-contract change, left
     to an app follow-up.
- **Consequences:**
  - A GPU load that arrives while another engine is still exiting waits for that exit instead of
    starting beside it.
  - An unload of image generation always answers after its `sd-server` is gone.
  - A diffusion load or respawn that races an unload fails with the cancel, which its caller already
    handles.
  - `SidecarTable` gained `stopping()`. Foundation Models shares the table but reports nothing to
    residency.
- **Owner:** `team`.
- **Links:**
  - `src/runtime/llamacpp/runtime.ts` (`stopping`), `src/runtime/shared/sidecar.ts` (`stopping()`),
    `src/diffusion/{session,service,state}.ts`, `src/core/gpu/residency.ts` (`granted`, the evict
    race), `src/core/gpu/policy.ts` (`remedy`), `src/core/tensorrt-llm.ts` (bounded retry),
    `src/runtime/managed-text/lifecycle.ts` (`stopPrevious(signal, generation)`),
    `src/core/create.test.ts`.
  - `.superpowers/sdd/tasks/findings-2.15-r1.md`.
