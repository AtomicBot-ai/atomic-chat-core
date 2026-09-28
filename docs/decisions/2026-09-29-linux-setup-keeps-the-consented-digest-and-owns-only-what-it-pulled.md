---
date: 2026-09-29
title: "Keep the consented plan digest on the wire, and remove only images the setup pulled"
---

# 2026-09-29 — Keep the consented plan digest on the wire, and remove only images the setup pulled

- **Context:** Review round 2 of task 2.6. After round 1, carried work moved `operation.plan_digest`
  to the re-probed digest while `approved_plan_digest` stayed the user's, so downloads ran with the two
  different on the wire (against spec `managed-runtime-environment` and the contract's own rule). And
  removal deleted the GPU-check image whenever the installation named it, even one the user already had.
- **Decision:**
  1. Once work started under a consent, `plan_digest` stays the consented digest (equal to
     `approved_plan_digest` outside `awaiting-consent`). Every later re-probe's digest goes to a new
     wire field, `EnvironmentOperation.carried_plan_digest` ("the plan the core continued under,
     covered by the consent basis"); it replaces the machine-internal field of
     2026-09-29-linux-setup-consent-binds-descriptor-and-disk-counts-what-is-left.
  2. `prepare` asks Docker whether the GPU-check image is absent by digest before pulling it and, if
     it is (a definite "no such image", never a failed inspect), records `image:<repo>@<digest>` in the
     operation's `owned_resource_ids` durably before the pull (`OperationStore.recordOwned`, same
     revision; `compareAndSwap` now keeps the union of owned ids, so a commit from an older read never
     drops one). Activation writes `installation.probe_image` only for an owned image; removal deletes
     only that, still guarded by "no container uses it" and "no other installation recorded it".
  3. Recovery compares descriptor ids for an activation without resolving the cache; the disk check is
     skipped only when the engine image is present by digest (or a pull began), not for a ready
     installation record alone; progress ticks re-read the shared record so another core's cancel
     stops them, and the per-operation `latest` map forgets finished operations.
- **Consequences:** clients see one approved plan per operation; `carried_plan_digest` tells them the
  host moved without asking anything new. An image already on the machine before setup is never
  removed by the app.
- **Owner:** `team`.
- **Links:** `src/contracts/environment.ts`, `src/runtime/environment/{state,store,service,linux-provisioner}.ts`,
  `test/e2e/managed-operations.test.ts`.
