---
date: 2026-09-30
title: "RequirementPlan reports the disk path and free space the core measured, outside the plan digest"
---

# 2026-09-30 — RequirementPlan reports the disk path and free space the core measured, outside the plan digest

- **Context:** Before the user consents, the app must show where the engine image will land and how
  much room is there (spec `tensorrt-llm-desktop`, scenario "Нет места под образ"; app ruling G-app-1).
  The core already measured both on every Linux setup probe, but `RequirementPlan` carried neither: the
  path lived only inside the `plan_digest` input (`host.docker_root_dir`), and the free bytes only in
  an `insufficient-disk` blocker's `params.free`, without the path. Task 2.22 (1) adds the two fields.
  Its text said `null` when `docker info` does not answer, but on a clean host the core still measures,
  at `/var/lib/docker` through its nearest existing ancestor, and still judges `insufficient-disk` on
  that number. The owner ruled (R-core-6) that the plan reports what the core actually used.
- **Decision:**
  1. `RequirementPlan.docker_root_dir` is the path the free space is for: `DockerRootDir` from
     `docker info` when the daemon answered, otherwise `/var/lib/docker`. It is never the ancestor
     the space was really read at. `probeLinux` now returns that path as `LinuxFacts.free_disk_path`,
     so the provisioner does not repeat the default.
  2. `RequirementPlan.free_disk_bytes` is `LinuxFacts.free_disk_bytes`, the value `assessLinux` reads
     for `insufficient-disk`. The plan and the blocker therefore always show the same number.
  3. When the free-space read failed, both fields are `null`. A path without a number would show a
     location with nothing to compare against. A removal plan, and a plan blocked before the probe (no
     descriptor), measure nothing, so they are `null` too.
  4. `plan_digest` does not change. Its `host` input keeps `docker info`'s own `DockerRootDir` (null
     on a clean host) and `disk_sufficient`. Neither the reported path nor the free number enters the
     digest. Adding them would change every existing digest, and a free-space number moves on its own
     from one probe to the next, so any consent given before this change would have to be given
     again for no reason.
- **Consequences:**
  - The addition is additive: control protocol 2 is unchanged, and a client that ignores the fields
    sees nothing different.
  - On a clean host, the path shown before consent is Docker's default. If Docker is later installed
    with a different `DockerRootDir`, the pre-install path was wrong. The next probe after install
    reports the real one, and the disk check uses it.
  - Plans persisted by an older core (`requirement_plan` in an operation record) lack the fields.
    Those plans are never returned to a client: only `POST …/environments/probe` returns a plan, and
    it is always computed fresh.
- **Owner:** team.
- **Links:** openspec change `add-tensorrt-llm-linux` (`atomic-chat-spec`), task 2.22 (1), design D16,
  rulings `core.md` R-core-6 and `app.md` G-app-1; `src/contracts/environment.ts` (`RequirementPlan`),
  `src/runtime/environment/{linux-probe,linux-provisioner}.ts`, `docs/contracts.md`.
