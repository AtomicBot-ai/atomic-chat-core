---
date: 2026-09-28
title: "Managed-runtime execution journal: an orphan is any instance id but our own, no liveness probe"
---

# 2026-09-28 — Managed-runtime execution journal: an orphan is any instance id but our own, no liveness probe

- **Context:** Task 2.10 (openspec change `add-tensorrt-llm-linux`) adds `execution-journal.ts` and
  `reconcile.ts`: at startup, before the first load can be served, the core must stop and remove the
  model containers a *previous* core instance left running, and never touch a container it did not
  journal itself. The native-process journal's equivalent, `process-journal.ts`'s `scanOrphans`,
  decides "belongs to a previous instance" by checking the record's `instance_id` against a set of
  *live* owner instance ids, because a `ChildProcessRecord`'s owner is a claim that can be true or
  false independently of whether the *current* process holds anything — several owners' records can
  coexist in that journal at once (app scope and CLI scope share one journal file, `docs/contracts.md`
  "App and CLI attach to the same owner"). `core/create.ts` always calls it with an empty live-set
  today, which already hints this liveness check is not load-bearing in the current single-owner
  world, but the method itself is written to support more.
- **Decision:** For the execution journal, "belongs to a previous instance" is decided by instance-id
  inequality alone: `record.instance_id !== currentInstanceId`, with no liveness probe of the other
  id. This is sound, not merely convenient: `InstanceLock` (`src/lock/instance-lock.ts`) guarantees at
  most one core instance holds a given data folder's lock at a time, and the execution journal lives
  under that same data folder (`<data>/atomic-core/managed-runtimes/executions/`). If *this* process
  now holds the lock and is reading the journal, any record stamped with a different instance id can
  only have been written by a *former* owner — the lock's mutual exclusion already disproved that
  owner's liveness as an owner of this folder before this process could ever have acquired it. There
  is no second "other core instance" to probe liveness of, the way `scanOrphans` must for a possibly
  still-running unrelated process. Reconcile still inspects the container itself through the executor
  (`operations.ts`'s `inspectContainer`) before acting — an absent container just drops its record, a
  present one is stopped with `stopContainer`'s confirmed-or-not outcome, and only a confirmed stop is
  followed by `removeContainer` and dropping the record. An unconfirmed stop keeps the record and is
  reported, never silently swallowed.
- **Consequences:** `reconcileExecutions` (`src/runtime/container/reconcile.ts`) takes a bare
  `currentInstanceId: string`, not a live-instance set, which is simpler than `scanOrphans`'s
  signature and correctly so — mirroring `scanOrphans`'s shape here would carry a liveness parameter
  this journal's directory scope makes meaningless, an unused knob that invites a future caller to
  pass something plausible-looking but wrong. If the managed-runtime layout ever becomes genuinely
  shared across instances (the way `processes.json` already is), this decision needs revisiting
  alongside whatever changes the journal's own scoping; nothing here assumes that will never happen,
  only that it is not true today. Labels (`ModelContainerLabels`) are still never consulted by
  reconcile for this decision or any other — only journal membership is (spec
  `tensorrt-llm-runtime`, "Метки контейнера MUST NOT служить единственным основанием для остановки").
- **Owner:** team.
- **Links:** openspec change `add-tensorrt-llm-linux` (`atomic-chat-spec`), task 2.10;
  `src/runtime/container/execution-journal.ts`, `src/runtime/container/reconcile.ts`,
  `src/lock/instance-lock.ts`, `src/lock/process-journal.ts` (`scanOrphans`, the pattern this narrows).
