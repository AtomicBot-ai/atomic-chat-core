---
date: 2026-09-30
title: "The GPU runtime is ready only with an NVIDIA CDI device; the recipe installs the full toolkit and generates the spec"
---

# 2026-09-30 — The GPU runtime is ready only with an NVIDIA CDI device; the recipe installs the full toolkit and generates the spec

- **Context:** the app acceptance run of task 3.10 (finding F-5, Ubuntu 26.04, Docker 29, RTX 4070) had
  only `nvidia-container-toolkit-base` on the host. The probe counted the toolkit as installed because
  `nvidia-ctk --version` answered, and the plan picked `nvidia-runtime` without the toolkit package. After
  setup the GPU check failed: Docker 29 serves `--gpus` through CDI, and with no spec in `/etc/cdi` or
  `/var/run/cdi` the device was "unresolvable". A runtime named `nvidia` was registered, and
  `linux-docker-facts.ts` accepted that as a GPU runtime. The round-3 record (2026-09-28, CDI default by
  engine version) also counted CDI only on Docker 28.2+ or with `features.cdi`.
- **Decision:** (owner ruling R-core-8.) The GPU runtime counts as ready only when `nvidia-ctk cdi list`
  names an `nvidia.com/gpu` device, whether or not the daemon answers, whatever the engine version or
  `features.cdi` say, and regardless of a runtime named `nvidia`. That runtime is still read
  (`DockerFacts.nvidia_runtime`), only to decide whether `nvidia-ctk runtime configure` (and with it the
  consented restart) is planned. The toolkit counts as installed only when the family's package
  database has the full `nvidia-container-toolkit` package (one single-package query per family:
  `dpkg-query`, `rpm -q` or `pacman -Q`; the CLI alone only on a family without one). Whenever the
  device is missing, the plan carries the system change `generate-cdi-spec`, which maps to the new
  recipe component `nvidia-cdi`. That step is satisfied when a device is already listed; otherwise it
  runs `nvidia-ctk cdi generate --output=/var/run/cdi/nvidia.yaml` (argv only, fixed path, the executor's
  10-minute command deadline) and lists again, failing if still nothing is there. Then, only where
  `systemctl list-unit-files` shows `nvidia-cdi-refresh.path` (NVIDIA Container Toolkit 1.18+) and it is
  not enabled, it runs `systemctl enable --now nvidia-cdi-refresh.path`, which never fails the step.
  The manual commands (Arch, gated distributions) gain the same `generate` line. The step runs after
  the runtime configuration and before `docker-service`. The recipe goes to revision 2, so its digest
  changes (pre-release). The `nvidia-ctk` and `systemctl` allowlist is now exact argv, whole.
- **Consequences:** a `-base`-only host gets the toolkit package, the NVIDIA repository and the spec in
  one consent. A host with a registered runtime but no spec, previously adopted, now gets a plan (the
  spec only, with no restart). The CDI-default rule of round 3 (engine version, `features.cdi`) is
  gone, and the engine version is diagnostic only. On Docker older than 28.2 with CDI off, `--gpus`
  goes through the full toolkit's hook, which the recipe installs; a hand-made host there with `-base`
  and a spec would be adopted and caught by the GPU check before the pull. Without the refresh unit,
  `/var/run/cdi` does not survive a reboot. The next probe then plans the spec again: one more consent,
  not a breakage. The step relies on Docker picking up a spec written while it runs (the CDI cache's
  refresh). This was not verified live.
- **Owner:** `team`
- **Links:** task 2.23 (F-5), `../atomic-chat-spec/openspec/changes/add-tensorrt-llm-linux/manual-test-3.10.md`,
  `rulings/core.md` R-core-8; `src/runtime/environment/linux-docker-facts.ts`, `linux-probe.ts`,
  `linux-plan.ts`, `linux-blockers.ts`; `src/host/recipes/install-container-runtime.ts`, `executor.ts`.

<!--
Supersedes: 2026-09-28-linux-probe-relogin-is-a-blocker-and-cdi-defaults-by-version-round-3.md (the CDI-default half only)
-->
