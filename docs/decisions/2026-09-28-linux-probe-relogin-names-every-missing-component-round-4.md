---
date: 2026-09-28
title: "Linux probe fix round 4: relogin names every missing component, and one install gate for every path"
---

# 2026-09-28 — Linux probe fix round 4: relogin names every missing component, and one install gate for every path

- **Context:** Task 2.4 fix round 4 (`findings-2.4-r4.md`). The round-3 record made `relogin-required`
  a blocker that fired alone, so a host that also lacked the toolkit or the GPU runtime learned
  about that only after logging out and back in. The controller refined ruling 4: the relogin blocker
  comes with every other component offline evidence shows missing, each as its own blocker, never a
  plan. Earlier rounds kept regressing adjacent branches because the access paths and the
  full-install path each carried their own copy of the distribution gating.
- **Decision:**
  - **Relogin + components.** When `docker_group.configured === true && !effective` and the account
    is not root (design D4), `assessLinux` returns `relogin-required` followed by one blocker per
    missing component: `docker-cli-missing`, `toolkit-missing`, `gpu-runtime-not-configured` (or
    `daemon-json-unreadable` when `daemon.json` cannot be read), `docker-service-inactive` (only for a
    confirmed inactive service; `'unknown'` is not evidence). On a recipe distribution these say
    setup will do it after the relogin and carry no commands; on Arch each carries its exact commands
    (full `pacman -Syu`, design D2); elsewhere package steps carry no commands and the gate's own
    blocker (`immutable-os` when a package is missing, `docker-unrecognised`,
    `distribution-not-in-recipe`) is appended.
  - **One install gate.** `installGate` (immutable → pacman → unrecognised docker → not on the recipe
    → recipe) is computed once and read by the relogin path, the group-only path and the full-install
    path; the four gate blockers moved to `linux-blockers.ts` (`gateBlocker`).
  - **Unreadable `daemon.json` is unknown for CDI too.** `daemonJsonFeaturesCdi` returns
    `'unreadable'`, which `cdiEnabledByDefault` never reads as enabled, so a 28.2+ engine no longer
    counts CDI as on behind a file that may say `features.cdi: false`.
  - **Docker Desktop on Arch.** The read-only `pacman -Q` query now asks for `docker docker-desktop`;
    a Desktop-only Arch host is `docker-desktop`, and Arch's `docker` package counts as an installed
    engine for the Desktop rule.
  - **Idempotent rpm-ostree group copy.** `grep -q '^docker:' /etc/group || grep -E '^docker:'
    /usr/lib/group | sudo tee -a /etc/group`.
  - **`ServerErrors` on the ≥28.3 shape.** `parseDockerInfo` keeps `ServerErrors` from the JSON a
    failed ≥28.3 call still prints (exit 1), as it already did for the ≤28.2 exit-0 shape; a non-zero
    exit is still never reachable.
- **Consequences:** A client rendering the relogin state must expect more than one blocker. Task 2.6
  still re-probes after the relogin; the components listed now are the same ones that probe would
  then plan on a recipe distribution. `LinuxProbeDeps.readFile` now documents its contract (null only
  for ENOENT, reject otherwise); whoever wires `probeLinux` to the real filesystem must honour it.
- **Owner:** team.
- **Links:** `.superpowers/sdd/tasks/findings-2.4-r4.md`; supersedes the "relogin fires alone" consequence
  of `docs/decisions/2026-09-28-linux-probe-relogin-is-a-blocker-and-cdi-defaults-by-version-round-3.md`;
  openspec change `add-tensorrt-llm-linux`, spec `managed-runtime-environment`, design D2/D4/D5;
  `src/runtime/environment/linux-plan.ts`, `linux-blockers.ts`, `linux-docker-facts.ts`, `linux-probe.ts`.

<!--
Supersedes: 2026-09-28-linux-probe-relogin-is-a-blocker-and-cdi-defaults-by-version-round-3.md
-->
