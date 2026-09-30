---
date: 2026-09-30
title: "Task 2.23 review minors: no CDISpecDirs requirement, receipt identity without the log tail, exact argv, a readable spec, the causing routes"
---

# 2026-09-30 — Task 2.23 review minors: no CDISpecDirs requirement, receipt identity without the log tail, exact argv, a readable spec, the causing routes

- **Context:** the review of `bb44a06` (task 2.23) approved it with seven minors. Several of them are
  decisions in their own right, and one records a relaxation the original records did not state.
- **Decision:**
  1. **`CDISpecDirs` is no longer required** for the GPU runtime. The round-2 records (2026-09-28
     "tightens ready-except-access", and "drops docker group tracking … recipe blocks pair") required
     that the daemon that answered list CDI spec directories next to a listed device. Since
     `2026-09-30-gpu-runtime-ready-only-with-an-nvidia-cdi-device.md`, a listed `nvidia.com/gpu`
     device alone decides, live and offline. The cost: a hand-made host with only `-base`, a spec, and
     a daemon with CDI off is adopted, and only the GPU check before the pull catches it.
  2. **A receipt's identity excludes `log_tail`.** The nonce-spent check digests every receipt field
     but the tail. A re-post that differs only in its tail, or has none, is the same receipt (a
     duplicate), not "a different result". The duplicate itself still answers 409
     `MANAGED_RECEIPT_CONFLICT`, as the spec's "Повтор квитанции" requires. A receipt without a tail
     digests exactly as before task 2.23.
  3. **The allowlist compares argv element by element** (`sameArgv`). This applies to every program
     with fixed shapes: `docker`, `journalctl`, `nvidia-ctk`, `systemctl`, the new `stat`/`chmod`, and
     the `dnf repoquery` prefix. `['enable', '--now docker']` never matches `['enable', '--now', 'docker']`.
  4. **The refresh unit follows systemd's `is-enabled` states.**
     - `enabled`, `enabled-runtime`, `static`, `indirect`, `generated`, `transient` and `alias` are left
       as they are.
     - `enable --now` runs only for `disabled`, `linked` and `linked-runtime`.
     - `masked`, and anything else, is reported and left alone.
     - A replay is `satisfied` in every case.
  5. **The spec is made world-readable.** Whether `nvidia-ctk cdi generate` leaves the spec `0644`
     differs across toolkit releases: the CDI library writes a `0600` temporary file and renames it.
     The core's probe lists devices as the user. So the `nvidia-cdi` step reads the spec's mode with
     `stat --format=%a /var/run/cdi/nvidia.yaml` and runs `chmod 0644 /var/run/cdi/nvidia.yaml` only
     when others lack the read bit. Both are exact allowlisted argv at the fixed path and are covered by
     the recipe digest. An unreadable mode fails the step.
  6. **The warning names only the routes that cause the overlap.** These are the fewest routes that
     cover every pool, chosen greedily and listed in table order, each with its interface
     (`128.0.0.0/1 via tun2`; `params.routes`, `params.devices`). An on-link LAN inside
     `192.168.0.0/20` next to a full tunnel is no longer named.
  7. **The failure text follows `daemon.json`.** For a failed receipt whose tail shows the pools
     message, the service asks the provisioner, read-only, whether `daemon.json` sets `bip` or
     `default-address-pools`.
     - Set: the message names the configured ranges as used up or overlapping.
     - Not set: the host's routes.
     - Unread: the likely cause, hedged.
- **Consequences:** the recipe digest changes again (pre-release). One more `daemon.json` read happens
  per such failed receipt. The live `address-pool-warning` compares the warning's routes with its own
  `/proc/net/route` computation. Still to be confirmed live: the spec's actual mode after `generate`,
  and Docker picking up a spec written while it runs.
- **Owner:** `team`
- **Links:** `.superpowers/sdd/tasks/review-2.23.md` (minors 1–7); `src/runtime/environment/store.ts`,
  `linux-docker-network.ts`, `host-step-failure.ts`, `service.ts`, `state.ts`, `linux-provisioner.ts`;
  `src/host/recipes/install-container-runtime.ts`, `executor.ts`.

<!--
Supersedes: 2026-09-28-linux-probe-tightens-ready-except-access-round-2.md (the CDISpecDirs requirement only)
Supersedes: 2026-09-28-linux-probe-drops-docker-group-tracking-and-recipe-blocks-pair.md (the CDISpecDirs requirement only)
-->
