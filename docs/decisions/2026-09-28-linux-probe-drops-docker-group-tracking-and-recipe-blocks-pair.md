---
date: 2026-09-28
title: "Linux probe drops docker-group tracking; the install recipe always pairs enable+group"
---

# 2026-09-28 — Linux probe drops docker-group tracking; the install recipe always pairs enable+group

- **Context:** Task 2.4 (openspec change `add-tensorrt-llm-linux`, spec `managed-runtime-environment`,
  design D2/D4/D5/D15/D16) ports the full Linux host assessment: `docker info` over the system socket,
  Docker's install method, rpm-ostree, SELinux, the GPU runtime, driver/card facts, distro/arch/package
  family, `DockerRootDir` and its free space, and running-container count — then turns those facts into
  adopt / install-plan / blocked. The task 2.1 port of `linux-probe.ts` (from `feat/tenzor-rt`) tracked
  `id -nG`/`getent group docker` as a `DockerGroupFacts { configured, effective }` pair and required
  `docker_group.effective` for `adopts_existing_engine`. The spec this task implements is explicit that
  access "MUST определяться фактическим вызовом daemon по системному сокету, а не членством в группе
  `docker`", and gives the scenario "root без группы docker, и `docker info` отвечает → доступ считается
  имеющимся, блокера про группу нет" — root has no group membership at all, and must still adopt.
  A few other choices in this task have the same shape — no scenario dictates them exactly, but getting
  them wrong changes what a plan proposes or what a client can trust — and are recorded here rather than
  each getting its own file.
- **Decision:**
  - Removed `DockerGroupFacts`/`docker_group` entirely rather than keeping it alongside the new
    daemon-reachability check. `dockerReady = daemon_reachable && gpu_runtime` is the only readiness
    test now (`linux-plan.ts`); nothing reads `id -nG` or `getent group docker` any more. This is a
    real behavior removal, not an addition: a previous non-root, non-group user who could not adopt
    now still cannot (daemon_reachable is false for them), and root now adopts cleanly with zero
    special-casing, which the old `docker_group.effective` gate could not do (root is not "in" the
    `docker` group).
  - When the daemon is not reachable and an install plan is built, the recipe always includes both
    `enable-docker-service` and `add-user-to-docker-group`, rather than trying to distinguish "Docker
    isn't running" from "Docker is running but this account isn't in the group" (`docker info`'s
    failure text is not reliably parseable, and Docker's own CLI attributes both to the same
    `Cannot connect` shape depending on version and distro). Both operations are idempotent (`systemctl
    enable --now` on an already-enabled unit, `usermod -aG` on an existing member), so pairing them
    unconditionally is safe and avoids guessing.
  - `may_require_relogin` is `true` exactly when the plan includes the group-add step — not a blanket
    `true` for every plan — because only a group change needs the next sign-in to take effect (design
    D4); a toolkit-only plan against an already-reachable daemon (Fedora + `moby-engine`) never adds the
    user to a group and so never needs a relogin.
  - The forced system-socket `docker info` call passes `-H unix:///var/run/docker.sock` as a CLI
    argument (`docker -H unix:///var/run/docker.sock info --format '{{json .}}'`) instead of adding an
    env-override parameter to `LinuxProbeDeps.exec`. Docker's own flag-precedence resolves `-H` over
    both `DOCKER_HOST` and an active `DOCKER_CONTEXT` for endpoint selection, so it achieves the spec's
    "не пользовательским Docker context" requirement without a second injection seam that nothing else
    in this module would use, and keeps `exec`'s shape identical to `HostExec` in `host-exec.ts` (so a
    later wiring task can hand `hostExec()` straight to `probeLinux` unchanged).
  - CDI GPU-runtime detection runs `nvidia-ctk cdi list` (read-only) and checks its output for an
    `nvidia.com/gpu` device, rather than listing `CDISpecDirs`' contents — there is no directory-listing
    dependency in this module, and `nvidia-ctk cdi list` is the one command that answers "is there an
    actual usable device" instead of "does an (possibly empty) spec directory exist."
- **Consequences:** Anything built on this probe (task 2.3's fix round, 2.6's plan-digest work) must not
  reintroduce `id -nG`/group-membership as an access signal — `docker info` reachability is the only
  test, by design, and is what makes root and ACL-based access work without special cases. A reviewer
  who expects `may_require_relogin: true` on every plan (a literal reading of the spec's install-plan
  requirement text, which states both fields together for the general case) should check the
  toolkit-only scenario in `linux-plan.test.ts` before objecting — that reading was considered and
  rejected because it does not match design D4's own conditioning of relogin on the group change, and
  no other reading distinguishes the Fedora + `moby-engine` scenario the brief also asks for. The
  enable+group pairing means a plan may include a step (starting a service that was already running, or
  adding an already-member user) that turns out to be a no-op; that is intended, not a bug to "fix" by
  adding daemon-error-text parsing later.
- **Owner:** team.
- **Links:** openspec change `add-tensorrt-llm-linux` (`atomic-chat-spec`), spec
  `managed-runtime-environment` (Probe/Install-plan/Blockers requirements), design D2/D4/D5/D15/D16;
  `src/runtime/environment/linux-probe.ts`, `src/runtime/environment/linux-docker-facts.ts`,
  `src/runtime/environment/linux-plan.ts`; supersedes the `docker_group` behavior ported in task 2.1's
  `linux-probe.ts`.
