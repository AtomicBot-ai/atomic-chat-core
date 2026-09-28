---
date: 2026-09-28
title: "Linux probe fix round 1: docker_group returns as diagnostics, may_require_relogin is always true"
---

# 2026-09-28 — Linux probe fix round 1: docker_group returns as diagnostics, may_require_relogin is always true

- **Context:** Task 2.4 fix round 1 (`findings-2.4-r1.md`) found that dropping `docker_group`
  entirely (the same-day ADR this one supersedes) threw away information task 2.6 actually needs:
  without it, "the daemon is confirmed running but this login session cannot reach it yet" (a plain
  relogin) is indistinguishable from "the daemon is not reachable, full stop" — both just read
  `daemon_reachable: false`. Item 2 asks for the group facts back as *diagnostics*, never as a gate
  on readiness, plus a new read-only `systemctl is-active docker` fact so the two cases can be told
  apart. Item 10 is a controller ruling: `may_require_relogin` must be `true` for every install plan
  this module returns, per a literal reading of the spec's install-plan requirement text
  (`requires_elevation: true, may_require_relogin: true` stated together) — overriding the previous
  ADR's "only when the group step is included" reasoning, which the round argued does not match that
  text. Item 3 found a related bug the group facts' absence made easy to miss: with `docker_group`
  gone, the old code planned `configure-nvidia-runtime` whenever `!daemon_reachable`, with no
  evidence at all about whether the runtime was already configured — including in exactly the
  relogin-only case, where the right answer is to change nothing and wait for the next probe.
- **Decision:**
  - `DockerGroupFacts { configured, effective }` is back on `LinuxFacts.docker_group`, read from
    `id -nG` / `getent group docker` exactly as task 2.1 had it, but **never** feeding
    `dockerReady`/`adopts_existing_engine` — that stays exactly `daemon_reachable && gpu_runtime`, so
    the previous ADR's core claim (access is decided by calling the daemon, not by group membership)
    still holds. `docker_group` is read for one purpose only: telling "just needs a relogin" apart
    from "actually not reachable" in the branch below.
  - Added `DockerFacts.service_active: boolean | 'unknown'` from `systemctl is-active docker`
    (read-only; never `enable`, `start` or `restart`). When `!daemon_reachable && service_active ===
    true`, `assessLinux` now takes a third path before the distro-qualification/pacman/immutable-os
    gating: an **access-only** plan whose only possible content is
    `add-user-to-docker-group` (emitted only when `!docker_group.configured`; nothing at all when the
    account is already a member and this is purely a "log back in" wait). No packages, no
    `configure-nvidia-runtime`, no `enable-docker-service` — this branch is reached precisely because
    the daemon is already running. This also answers item 3: a runtime reconfigure is now only ever
    planned from real evidence, either `docker info` itself (daemon reachable) or, when it is not,
    `/etc/docker/daemon.json`'s own `runtimes.nvidia` entry or a listed CDI device
    (`DockerFacts.gpu_runtime_from_config`, new) — never blindly because the daemon happened to be
    unreachable.
  - Outside the access-only branch, `enable-docker-service` and `add-user-to-docker-group` are each
    emitted independently again (service not active → enable it; account not configured → add it),
    rather than the previous ADR's "always pair them, both are idempotent" shortcut — the access-only
    branch above makes that shortcut unnecessary, since the one case it was covering for (relogin
    only, nothing to install) now has its own explicit path.
  - `may_require_relogin` is now `true` for every `LinuxInstallPlan` this module returns, full stop —
    including the toolkit-only Fedora/`moby-engine` plan, which the previous ADR used as the reason
    to make it conditional. That reasoning is overruled by item 10, not re-litigated here.
    `requires_elevation` still varies (`system_changes.length > 0`): the access-only plan for an
    account already in the group is `requires_elevation: false, may_require_relogin: true,
    system_changes: []` — nothing to run as root, but still worth telling the person to log back in
    and check.
  - The env-stripping half of the previous ADR's `-H`-flag reasoning is also revised (item 17,
    unrelated to items 2/10 but touching the same call site): `LinuxProbeDeps.exec` gained an
    optional third `env` parameter, and the forced `docker info` call now explicitly strips
    `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_TLS_VERIFY` and `DOCKER_CERT_PATH` rather than relying on
    `-H` alone — the round's review judged flag-precedence alone not worth trusting for the TLS
    variables, which `-H` does not obviously override the way it does the host itself. The `-H` flag
    stays as defense in depth.
- **Consequences:** 2.6 can now build a real `relogin-required` phase from `docker_group` +
  `service_active` instead of reconstructing it from `daemon_reachable` alone, which is what item 2
  was for. A caller must not read `docker_group` as an access signal — it is exactly as inert for
  `adopts_existing_engine` as it was after the previous ADR, just visible again. Any future change to
  the access-only branch's conditions should keep it package-free: it exists specifically so a
  relogin-only host is never told to reinstall or reconfigure anything it already has.
- **Owner:** team.
- **Links:** `.superpowers/sdd/tasks/findings-2.4-r1.md` (items 2, 3, 10, 17); openspec change
  `add-tensorrt-llm-linux`, spec `managed-runtime-environment`, design D2/D4/D5;
  `src/runtime/environment/linux-probe.ts`, `src/runtime/environment/linux-docker-facts.ts`,
  `src/runtime/environment/linux-plan.ts`.

<!--
Supersedes: 2026-09-28-linux-probe-drops-docker-group-tracking-and-recipe-blocks-pair.md
-->
