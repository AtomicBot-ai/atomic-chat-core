---
date: 2026-09-29
title: "Linux setup: an install plan needs systemd, and a host without it is blocked before consent"
---

# 2026-09-29 — Linux setup: an install plan needs systemd, and a host without it is blocked before consent

- **Context:** A core built for linux-arm64 probed a GB10 host: a vast.ai container on a DGX Spark-class
  machine, Ubuntu 24.04. It found the card correctly and answered with no blockers and a full recipe
  plan: add the Docker and NVIDIA repositories, install `docker-ce`, `docker-ce-cli`, `containerd.io`
  and `nvidia-container-toolkit`, configure the runtime, "Enable and start docker.service". That
  container has no systemd: PID 1 is `bash` and `/run/systemd/system` is absent. The
  `linux.install-container-runtime` recipe enables, starts and restarts Docker through `systemctl`, so
  the plan could only fail at the privileged step, after the user had already consented and entered a
  password.
- **Decision:** (controller ruling)
  1. `probeLinux` reads a new fact, `systemd: boolean | 'unknown'`: whether `/run/systemd/system`
     exists. That is the `sd_booted()` test. It goes through the injected `pathExists` seam, and a
     rejected check is `'unknown'`, never assumed either way.
  2. `assessLinux` refuses the recipe install plan when `systemd !== true`. It returns
     `prerequisite-blocked` with one `init-not-systemd` blocker: "This system does not run systemd,
     which the Docker install needs." (`params.systemd: 'absent'`), or "Could not tell whether this
     system runs systemd, …" (`'unknown'`). The check sits after the universal blockers, the adopt
     path, the access paths, distribution gating and the `daemon.json` check, right before the plan
     is built.
  3. A host whose Docker already answers with a GPU runtime still adopts with no blocker. Nothing in
     an adopted setup calls `systemctl`, so a container that runs its own `dockerd` stays usable.
- **Consequences:**
  - The GB10 container from the live probe now gets a clear blocker before consent instead of a plan
    that fails after it.
  - Scope is the recipe plan only. Arch's manual commands and the immutable-OS step list still include
    `systemctl` lines on a host without systemd. The relogin path's "setup will do this after you log
    back in" wording can also promise a plan that the next probe then blocks. Neither was in the ruling.
  - The group-only recipe plan (`usermod` alone) needs no systemd and is not gated. It is reachable
    only when `systemctl is-active docker` answered `active`, which a host without systemd does not.
  - Test harnesses that stand in for a desktop host now declare `/run/systemd/system`
    (`test/helpers/fake-managed-host.ts`, the provisioner test harness).
- **Owner:** `team`
- **Links:** `src/runtime/environment/linux-probe.ts` (`LinuxFacts.systemd`),
  `src/runtime/environment/linux-blockers.ts` (`initNotSystemdBlocker`),
  `src/runtime/environment/linux-plan.ts` (`assessLinux` step 6); tests in `linux-plan.test.ts`,
  `linux-blockers.test.ts`.
