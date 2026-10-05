---
date: 2026-09-28
title: "src/runtime/environment/inventory.ts is the model-file digest, not the host-inventory report"
---

# 2026-09-28 — `src/runtime/environment/inventory.ts` is the model-file digest, not the host-inventory report

- **Context:** Task 2.2's brief names two things "inventory" that are unrelated on
  `origin/feat/tenzor-rt` @ `632b934`, and asks for both under the same filename. First, the brief's
  port list says to port `src/runtime/environment/inventory.ts` alongside `linux-probe`,
  `host-exec`, `windows-probe`. On the branch, that exact path is `collectInventory` /
  `redactInventory` — a redacted hardware report for a bug-report attachment (commit 632b934,
  "read what a test host can do before touching it"), built on `probeLinux`/`probeWindows`, whose own
  associated live test (`test/live/managed-host-inventory.test.ts`) is not in the task's file list.
  Second, the brief separately and explicitly describes what `inventory.ts` should contain: "port
  ONLY the inventory-digest algorithm ... Drop `ArtifactLocation` / `ModelResolution` / artifacts
  store / HF token (design D12)", matching conf's README ("Runtime descriptors" → `inventory_digest`)
  and `atomic-chat-conf/.github/scripts/inventory-digest.mjs`. That algorithm is not in the branch's
  `inventory.ts` at all — `git log` on that path shows only the one host-report commit. It lives in
  `src/models/snapshot-plan.ts` (`inventoryDigest`, `ArtifactIdentity`, `artifactId`, `planSnapshot`,
  ...), a file the branch's own `inventory-digest.mjs` header names as the algorithm's origin, wrapped
  together with exactly the storage-domain/artifact-identity machinery D12 says core no longer needs
  (core does not download model weights; the app and CLI do).
- **Decision:** `src/runtime/environment/inventory.ts` on `main` holds the digest algorithm, not the
  host-report feature. It exports `InventoryFile` (`path`, `bytes`, optional `sha256`) and
  `inventoryDigest(files)`, ported from `snapshot-plan.ts`'s function of the same name with its
  `AtomicCoreError` codes kept, and with `StorageDomain`, `ArtifactIdentity`, `artifactId`,
  `sameArtifact`, `ArtifactProvenance`, `SnapshotPlan` and `planSnapshot` left behind per D12. Its
  test reuses `atomic-chat-conf`'s own test vectors (`inventory-digest.test.mjs`, which states they
  were produced by running this exact core function) rather than a live Hugging Face fetch, so the
  two implementations are checked byte-for-byte without a network dependency in the test suite. The
  branch's host-inventory-report feature (`collectInventory`, `redactInventory`, `HostInventory`) is
  not ported: nothing in this task's route or service surface calls it, its own live test is outside
  the task's file list, and it answers a different question (what can this bug-report machine already
  do) than what task 2.2 needs `inventory.ts` for (verifying a curated model's file listing against
  its descriptor digest, spec `tensorrt-llm-models`).
- **Consequences:** `linux-probe.ts`, `windows-probe.ts` and `host-exec.ts` are ported as their own
  standalone, already-tested probes (none of the three reads or writes anything descriptor-shaped, so
  they needed no adaptation beyond the copy) — task 2.4 is what wires `probeLinux`/`assessLinux` into
  a real `EnvironmentProvisioner.probe`, not this task. If a hardware-qualification bug-report tool
  is still wanted later, it is a fresh addition built on the now-ported `linux-probe.ts` /
  `windows-probe.ts`, not a file this task already claimed for a different purpose. A future reader
  who expects `inventory.ts` to mean "what does this host look like" (the branch's meaning) needs this
  record to find where that logic actually would go.
- **Owner:** team.
- **Links:** openspec change `add-tensorrt-llm-linux` (`atomic-chat-spec`), task 2.2, design D12;
  `atomic-chat-conf` README "Runtime descriptors", `.github/scripts/inventory-digest.mjs` and
  `inventory-digest.test.mjs`; source `origin/feat/tenzor-rt` @ `632b934`'s `src/models/snapshot-plan.ts`
  and `src/runtime/environment/inventory.ts`; `src/runtime/environment/inventory.ts`,
  `src/runtime/environment/inventory.test.ts` on `main`.
