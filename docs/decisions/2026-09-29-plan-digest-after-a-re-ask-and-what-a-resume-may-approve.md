---
date: 2026-09-29
title: "Plan digest after a re-ask, and what a resume may approve"
---

# 2026-09-29 — Plan digest after a re-ask, and what a resume may approve

- **Context:** The record 2026-09-29-linux-setup-resume-never-swaps-the-approval says a resume
  "never swaps the approval" and that the contract states exactly where `plan_digest` and
  `approved_plan_digest` are equal. Both are inexact about one path the code has always taken
  (ledger 275, final review M-11): after work began, a probe that finds the host changed beyond what
  the consent covers re-asks — `awaiting-consent` with the new plan in `plan_digest` while
  `approved_plan_digest` still names the old approval — and a phase reached from there (a cancel, a
  failed or blocked probe) keeps the two different. And `resume` accepts an `approved_plan_digest`
  equal to the operation's current `plan_digest`: after a re-ask that is the plan on offer, so such a
  resume does replace the approval, with one the user saw a plan for.
- **Decision:** No behaviour changes. The text now says what the code does: in a non-work phase
  reached through a re-ask, `plan_digest` is the plan last offered and may differ from the approval;
  work never starts again until they are equal; and a resume may carry an approval only of the plan
  the operation names now (normally restating the approval it has, after a re-ask approving the
  plan on offer), never of any other digest (`MANAGED_PLAN_CHANGED`). This corrects the title claim
  and the contract sentence of the record named above; the rest of it stands.
- **Consequences:** A client reading `plan_digest ≠ approved_plan_digest` outside a work phase after
  work began knows it is looking at a re-ask, not at an inconsistency. Nothing on the wire changes.
- **Owner:** `team`.
- **Links:** `src/contracts/environment.ts` (`EnvironmentOperation`), `src/runtime/environment/state.ts`
  (`probedDigest`, the `resume` event).

<!--
Supersedes: the title claim and the contract sentence of 2026-09-29-linux-setup-resume-never-swaps-the-approval.md
-->
