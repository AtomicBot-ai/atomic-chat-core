---
date: 2026-09-28
title: "Linux probe fix round 5: an effective group member with something missing gets the plan, not access-unexplained"
---

# 2026-09-28 — Linux probe fix round 5: an effective group member with something missing gets the plan, not access-unexplained

- **Context:** Task 2.4 fix round 5 (`findings-2.4-r5.md`). The round-4 relogin blockers tell a
  person on a recipe distribution that setup will install/configure/start the missing components
  after they log back in. After the relogin the same host reads `configured && effective &&
  !daemon_reachable`, and `assessLinux` answered that with `docker-access-unexplained`
  unconditionally, so the promised plan never came. That also contradicted the spec's install-plan
  requirement for a recipe host with Docker missing.
- **Decision:**
  - `docker-access-unexplained` for a confirmed, effective member now requires that
    `missingComponentBlockers` is empty. When something is missing (Docker gone, the service
    stopped, the toolkit or runtime absent), that explains the refusal; the host falls through to
    distribution gating and the install plan. The plan adds no group step, because the account is
    already a member. A two-step scenario test (relogin blockers → same host after the relogin)
    checks that each promised component is covered by a plan step.
  - One gate decision, `gateBlockerApplies`, is read by both the relogin and full-install paths.
    On an immutable base the gate applies only when a package (Docker, toolkit) is missing. There,
    `immutable-os` names exactly those packages and never says "install docker-ce" to a host that
    already has an engine. With the packages layered, the remaining steps (runtime, service, group)
    are reported one by one with their commands.
  - Arch's manual commands omit `usermod` for an account that is already a member.
  - `pacman -Q` runs only on a pacman-family distribution.
- **Consequences:** The round-4 record's statement that the relogin blockers match what the next
  probe plans is now true and covered by a test. The Silverblue full-install output changes wording
  only when a package is missing; hosts with both packages layered now get per-step blockers
  instead of the generic `immutable-os`.
- **Owner:** team.
- **Links:** `.superpowers/sdd/tasks/findings-2.4-r5.md`; supersedes the unconditional
  `docker-access-unexplained` rule of
  `docs/decisions/2026-09-28-linux-probe-tightens-ready-except-access-round-2.md` and the
  immutable-gate divergence in
  `docs/decisions/2026-09-28-linux-probe-relogin-names-every-missing-component-round-4.md`; openspec
  change `add-tensorrt-llm-linux`, spec `managed-runtime-environment`, design D2/D4;
  `src/runtime/environment/linux-plan.ts`, `linux-blockers.ts`, `linux-probe.ts`.

<!--
Supersedes: 2026-09-28-linux-probe-relogin-names-every-missing-component-round-4.md
-->
