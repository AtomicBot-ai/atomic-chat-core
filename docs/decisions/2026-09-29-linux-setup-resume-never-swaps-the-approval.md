---
date: 2026-09-29
title: "A resume never swaps the approval; carried work runs under the consented digest"
---

# 2026-09-29 — A resume never swaps the approval; carried work runs under the consented digest

- **Context:** Review round 3 of task 2.6 reproduced two paths where a work phase ran with
  `approved_plan_digest ≠ plan_digest`: a `resume` that brought a different approval after a
  failure mid-pull, and a core restart while the operation was re-asking after work began.
- **Decision:** A consent carries over only while the approval on record is still the consent the
  work began under (`approved_plan_digest === consented.plan_digest`), and carried work sets
  `plan_digest` to that consented digest; otherwise the operation asks again (`MANAGED_PLAN_CHANGED`).
  `resume` outside `awaiting-consent` refuses an `approved_plan_digest` other than the operation's
  current `plan_digest` with `MANAGED_PLAN_CHANGED` (409) and changes nothing — refused rather than
  ignored, so a client meaning to approve something new finds out. The contract states exactly where
  the two digests are equal (every work phase, `ready`, `removed`) and where they may differ.
  Also: a repeat setup carries the installation's recorded GPU-check image forward when the digest
  matches; a ready installation on a daemon this user cannot reach raises no disk blocker (presence
  unknown, not absent); `owned_resource_ids` is documented as monotonic in the store.
- **Consequences:** clients approve only in `awaiting-consent`; a resume is only ever "continue". An
  earlier setup attempt that pulled the GPU-check image and never activated leaves no record, so that
  image stays for the user to remove (the safe direction).
- **Owner:** `team`.
- **Links:** `src/runtime/environment/{state,linux-provisioner,store}.ts`, `src/contracts/environment.ts`.
