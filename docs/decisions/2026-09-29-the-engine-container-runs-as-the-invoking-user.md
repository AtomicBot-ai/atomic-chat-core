---
date: 2026-09-29
title: "The engine container runs as the invoking user, and a removal never leaves a ready record behind"
---

# 2026-09-29 — The engine container runs as the invoking user, and a removal never leaves a ready record behind

- **Context:** The NGC TensorRT-LLM release image runs as root, and the model container was created
  without `--user`. The engine writes its JIT caches (`inductor/`, `triton/`, `nvcc/`) into the
  read-write engine cache mount (`<data>/atomic-core/managed-runtimes/caches/<descriptor>/<model>/`),
  so those directories came out owned by uid 0. The core runs as the user and removes the cache with
  a plain recursive `rm`, which fails with `EACCES` inside a root-owned directory. A removal of the
  engine ran `docker image rm` first and the cache step after it, so it failed with the image already
  gone and the installation record still `ready`: every retry failed at the same step, every load
  failed at `docker create --pull=never` with "No such image", and only `sudo rm -rf` recovered
  (final review I-1). The same root-owned tree defeats the spec's "the cache MUST be removed with its
  model or engine installation".
- **Decision:** Every model container runs as the core's own numeric user: `docker create --user
  <uid>:<gid>`. `create.ts` reads `process.getuid()`/`getgid()` at composition time — the same place
  it reads `process.arch` — and injects them through `wireTensorrtLlm` into the managed-text
  lifecycle; `argv.ts` accepts only non-negative safe integers there. The image has no passwd entry
  for that uid, so the lifecycle also sets `USER`/`LOGNAME=atomic` (Python's `getpass.getuser()`,
  which torch's inductor calls, raises for an unknown uid unless one of them is set) and points
  `HOME` and `XDG_CACHE_HOME` at `home/` and `xdg-cache/` inside the read-write engine cache, which
  core creates before the container starts; the adapter's env cannot override these, and the
  watchdog's own variables still come last. Independently, the Linux removal marks the installation
  `removing` before it touches the image: from then on a load is refused as "not ready"
  (`MANAGED_ADAPTER_UNAVAILABLE`) instead of reaching Docker, and a removal that fails at a later step
  (the caches, the models) stays retryable — a retry skips what is already gone and deletes the
  record at the end.
- **Consequences:** Everything the engine writes into the cache is the user's own, so removing a model
  or the engine needs no privilege. The pinned image is not proven to run non-root: live test 2.19
  must load a real model under `--user`, then remove the engine and assert the cache and record are
  gone. If it shows the image cannot run as an arbitrary uid (a write to a root-only path at startup,
  a library that insists on a passwd entry), the fallback — deliberately not built now — is to keep
  the image's user and empty the cache through a one-shot container of the pinned image
  (`docker run --rm --pull=never -v <cache>:/c[:z] --entrypoint rm <image> -rf /c/<sub>`) before the
  host-side `rm`. The `removing` mark holds either way. A core started with `sudo` runs its
  containers as root, which is what it already owns.
- **Owner:** `team`.
- **Links:** `src/runtime/container/argv.ts` (`userFlags`), `src/runtime/container/types.ts`
  (`ContainerUser`), `src/runtime/managed-text/lifecycle.ts` (`containerUserEnv`,
  `CONTAINER_USER_NAME`), `src/core/tensorrt-llm.ts` (`containerUser`), `src/core/create.ts`,
  `src/runtime/environment/linux-provisioner.ts` (`remove`), ADR
  2026-09-29-linux-setup-operation-and-engine-removal.
