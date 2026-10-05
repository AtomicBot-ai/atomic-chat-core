---
date: 2026-09-29
title: "The tensorrt-llm provider shares the setup operation's Docker handle, installation store and machine"
---

# 2026-09-29 — The tensorrt-llm provider shares the setup operation's Docker handle, installation store and machine

- **Context:** Tasks 2.6 (Linux setup and removal) and 2.14 (the `tensorrt-llm` provider) were built in
  parallel lanes and each carried a stopgap for the other: 2.14 wired its own startup Docker executor
  promise, read `installations/<id>/installation.json` with its own parser, and read
  `ATOMIC_MANAGED_TEST_HOST` itself; 2.6 left `unloadEngineSessions` at "nothing loaded". Both
  records say the stopgaps end when the other lane lands
  (2026-09-29-tensorrt-llm-sessions-carry-a-route-policy-to-the-public-server, items 3–4;
  2026-09-29-linux-setup-operation-and-engine-removal).
- **Decision:**
  1. **One Docker executor, through the handle.** `wireManagedEnvironment` builds the one
     `ManagedContainersHandle`; core startup resolves it once (reconciling the journal) before
     `managed.recover()`, and both the setup/removal and the provider go through it. The provider's
     lifecycle is now asked for at every load (`TensorrtLlmRuntimeDeps.lifecycle` is a function) and
     built once over the handle's executor and journal. A host with no docker CLI at startup that
     gets one from the setup's privileged step loads models without a core restart; a one-shot
     startup promise would have said "Docker is not installed" until then.
  2. **Removal unloads first.** `tensorrtLlmSessionUnloader` is the environment's
     `unloadEngineSessions`: for the `tensorrt-llm` engine it calls `TensorrtLlmRuntime.unloadAll()`,
     whose every unload confirms the container's stop; `MANAGED_STOP_UNCONFIRMED` fails the removal
     with nothing removed (spec "Удаление при загруженной модели").
  3. **One installation reader.** `resolveReadyInstallation` takes the setup operation's
     `InstallationStore`; the provider's own `listInstallations` is gone.
  4. **One place reads the test hook.** `wireManagedEnvironment` returns the effective platform
     (`linux` on the test host) and its `LinuxHost`; the provider runs `nvidia-smi` through that
     machine's `probeDeps.exec` (`bin/nvidia-smi` on the test host, `nvidia-smi` by name otherwise).
  5. **Host facts stay a fresh probe per load**, not the environment snapshot's `gpus`/`selinux`.
     That view is refreshed only by a setup or removal probe and is empty after a restart, so it
     would miss a card that disappeared between two loads (spec "Выбранная карта исчезла"), and a
     `null` SELinux there would still need a probe. An unanswered `docker info` still refuses the load.
- **Consequences:** A load is not serialised with a removal. The removal unloads whatever is loaded
  or loading when its first step runs, and a load that starts after the record is deleted is refused
  (`MANAGED_ADAPTER_UNAVAILABLE`). A load already past its installation check but not yet at
  `docker create` when the unload runs is a narrow open window: if its container is created before
  the removal's image check, the image is kept (it is in use) and that model stays loaded with its
  installation gone. Closing it means the provider refusing loads while a removal of its engine is
  active — not done here. The provider e2e now writes the full installation record the setup writes
  (`image`, `platform`, `installed_at`); a record without them is skipped as foreign.
- **Owner:** `team`.
- **Links:** `src/core/tensorrt-llm.ts`, `src/core/managed-environment.ts`, `src/core/create.ts`,
  `src/runtime/tensorrt-llm/{runtime,installation}.ts`, `test/e2e/tensorrt-llm-provider.test.ts`.

<!--
Supersedes: items 3 and 4 of 2026-09-29-tensorrt-llm-sessions-carry-a-route-policy-to-the-public-server.md
-->
