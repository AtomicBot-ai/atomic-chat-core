---
date: 2026-09-29
title: "Bind a carried-over consent to its descriptor, and count only the disk the image still needs"
---

# 2026-09-29 — Bind a carried-over consent to its descriptor, and count only the disk the image still needs

- **Context:** Review round 1 of task 2.6 found two holes in
  2026-09-29-linux-setup-operation-and-engine-removal. (1) The free-space blocker counted the whole
  image against what was left after part or all of it was already pulled, so a restart mid-pull failed
  and a finished installation read as disk-blocked. (2) A consent carried over to any later plan with no
  host step, and every effect re-resolved the descriptor with a fallback to the newest one, so an image
  nobody approved could be downloaded.
- **Decision:**
  1. The disk requirement is what the engine image still needs: none once it is present by digest or
     the installation is ready, none checked once a pull has begun (its layers already sit in
     `DockerRootDir`; the rest is not measurable), the full `required_disk_bytes` otherwise. The plan
     digest takes the boolean "free space suffices" (plus `DockerRootDir`), not a number.
  2. When work first starts under a matching approval, the machine records the consent's basis
     (`OperationMachine.consented`: the approved digest, `descriptor_id`, the engine `image_digest` —
     new on `RequirementPlan` — and the target). A later plan carries over only with the same three
     (a removal: the same target); otherwise `awaiting-consent` with `MANAGED_PLAN_CHANGED`. The user's
     `approved_plan_digest` is never rewritten; the carried digest is `OperationMachine.carried_plan_digest`.
  3. After the consent, every probe and effect resolves only the consented descriptor from the cache;
     missing is `MANAGED_METADATA_INVALID`, never a fallback.
  4. Also: an operation waiting on the user (`awaiting-consent`, `relogin-required`, `reboot-required`)
     is never ended as abandoned by a later `begin`; the GPU-check image is recorded on the installation
     and removed with it unless another installation or a container uses it; progress ticks go out only
     for the operation's current revision, on an injected clock; the snapshot re-reads installations on
     every look at the host.
- **Consequences:** a restart mid-pull on a disk the image filled continues; a new descriptor published
  mid-operation asks again instead of downloading. A partial pull that got stuck is not re-checked for
  space; Docker reports the pull's own failure if the disk fills.
- **Owner:** `team`.
- **Links:** `src/runtime/environment/{state,linux-provisioner,service,wiring}.ts`,
  `test/e2e/managed-operations.test.ts`, 2026-09-29-linux-setup-operation-and-engine-removal.md.
