---
date: 2026-09-29
title: "Run the Linux engine setup and removal as one durable operation"
---

# 2026-09-29 — Run the Linux engine setup and removal as one durable operation

- **Context:** Task 2.6 of `add-tensorrt-llm-linux` (spec `managed-runtime-environment`: "Setup через
  durable-операцию с согласием", "Один привилегированный шаг…", "Повторный вход…", "Восстановление
  операций…", "Удаление установки движка"). The ported state machine had every phase, but no Linux
  provisioner, no installation record, no handling of a resume's `reconcile`, and three gaps the spec
  cannot live with: a consent was re-asked after every sign-in or restart (the plan digest moves once
  work starts), a relogin was taken from the client's receipt, and pull progress was dropped.
- **Decision:**
  1. `createLinuxProvisioner` (`src/runtime/environment/linux-provisioner.ts`) implements every
     effect over `probeLinux` → `assessLinux`, the startup Docker executor and an injected recipe
     binding (`INSTALL_CONTAINER_RUNTIME_BINDING`; the environment module cannot import `src/host`).
     It is engine-neutral: engine, image, probe image and requirements come from the descriptor.
  2. **Consent carries over once acted on.** The machine records the last work phase it entered
     (`OperationMachine.checkpoint`). A later probe whose plan has no privileged step continues from
     there without a new consent (after a sign-in: the GPU check; mid-pull: verification when the
     image is there by digest, the pull otherwise); a plan that needs a new privileged change (a
     Docker restart) goes back to `awaiting-consent` with `MANAGED_PLAN_CHANGED`.
  3. **The probe decides a relogin, never the receipt.** After a receipt claiming the step ran, the
     host is probed again: only the relogin blocker left → `relogin-required`
     (`MANAGED_RELOGIN_REQUIRED`); anything else missing → `failed` with the probe's findings. A probe
     answering with only the relogin blocker parks the operation the same way. `restart-docker` is now
     planned when the daemon is active but not yet reachable by the user, so the runtime the step
     registers is loaded without a second elevation after the sign-in (task 2.5 report, concern 2).
  4. **The plan digest covers the host:** the structured system changes, the GPU UUID set and free
     space in `DockerRootDir` rounded down to whole GiB (exact bytes would invalidate every consent
     within seconds).
  5. **A receipt binds to the whole step:** step id, nonce, the revision the reducer stamps on the step
     when it issues it, and both digests. A used nonce with other content, another nonce, or another
     revision is `MANAGED_RECEIPT_CONFLICT`; recording the nonce and the transition is one
     compare-and-swap, so a receipt racing itself applies once. The step carries the recipe's
     validated `parameters` for the client's request file.
  6. **Byte progress** of a pull is announced on `environment:operation` (throttled, first tick
     always) without a new revision — the pull effect must answer at the revision it was issued at —
     and `get` shows it while the pull runs.
  7. **A `begin` blocked by an operation whose owner process is provably gone** ends that operation
     and proceeds, instead of waiting for the next core start to recover it.
  8. **Descriptor:** the plan names its `descriptor_id` (new contract field): the one the operation's
     plan already named or the request named, when cached, else the newest. The plan is persisted with
     the record so pull and activation use the same one. Setting up over an installation pinned to
     another descriptor is refused (design D7: a new release applies after remove + setup).
  9. **Removal:** unload the engine's loaded sessions through an injected callback (task 2.14's
     provider; `NOTHING_LOADED` until then), stop-and-remove this core's journalled containers of the
     engine (an unconfirmed stop fails the removal), remove the image by digest only when
     `docker ps --all --filter ancestor=` lists no container, never `--force`, remove this scope's
     engine caches of the pinned descriptor, the models only for `retain_models: false`, and the
     installation record. Docker, the toolkit, the group, repositories and foreign containers or images
     are never touched.
  10. **One Docker executor:** `createManagedContainersHandle` wires it at startup (now before
      recovery, so a recovered pull has it) and again on first use if Docker was absent at startup;
      task 2.14 must take the same handle.
  11. **Test hook** `ATOMIC_MANAGED_TEST_HOST` (like `ATOMIC_CHATGPT_*`, never set in production)
      names a folder standing in for a whole Linux machine, so the compiled core's e2e runs the full
      setup on any OS with fake binaries and a fake Engine API.
- **Consequences:** a sign-in or a crash never re-asks for what the user approved; the operation
  never trusts the helper. Known limits: the other scope's engine caches of a removed descriptor stay
  (keyed by descriptor, never read by another release); a socket-activated Docker (`docker.socket`
  active, `docker.service` inactive) reads as inactive, so the plan includes `enable-docker-service`
  (harmless inside the consented step; after our own step the service is started, so the relogin check
  sees it active); byte progress is not persisted, so a client that reconnects mid-pull sees it from
  the next tick.
- **Owner:** `team`.
- **Links:** `src/runtime/environment/{state,service,linux-provisioner,linux-host,installations,wiring}.ts`,
  `src/core/managed-environment.ts`, `src/runtime/container/wiring.ts`,
  `test/e2e/managed-operations.test.ts`.
