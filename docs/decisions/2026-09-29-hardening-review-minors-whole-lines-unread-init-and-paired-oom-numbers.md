---
date: 2026-09-29
title: "Hardening review minors: the capped log keeps whole lines, an unreadable init system is an unread fact, and OOM numbers come from one failure"
---

# 2026-09-29 — Hardening review minors: the capped log keeps whole lines, an unreadable init system is an unread fact, and OOM numbers come from one failure

- **Context:** The review of the unverified-hardware-paths work was approved with four minors to
  fix. Each one corrects a statement in a record from the same day.
  1. The docker exec's head+tail cap joined its two halves with a newline and cut both mid-line. The
     tail's first line therefore had no timestamp. `containerLogs` merges stdout and stderr by each
     line's leading timestamp (`operations.ts`), so that fragment sorted after every stamped line of
     the other stream and misordered the rest of its own. The reviewer reproduced it. The order-based
     outputs depend on that merge: the last-failure OOM numbers, the excerpt order, and the
     `lastLogLines` fallback. Record
     `2026-09-29-tensorrt-llm-whole-log-read-keeps-both-ends-and-architecture-comes-first.md` called
     the effect "one garbled line", which was wrong.
  2. The real `pathExists` (`linux-host.ts`) read every `stat` error as "absent". An `EACCES` on
     `/run/systemd/system` therefore reported "does not run systemd". Record
     `2026-09-29-linux-setup-needs-systemd-for-an-install-plan.md` says "a rejected check is
     'unknown'", which no production path could reach. It also departed from the probe's convention
     that a fact which could not be read goes into `unknown` and becomes an `unknown-fact` blocker.
  3. `compatibility.ts` (pure policy) imported `tensorrtLlmUnifiedKvMaxTokens` from `adapter.ts`, and
     through it pulled in the managed-text lifecycle at runtime.
  4. `classifyOom` took "Tried to allocate" and "of which … is free" each from its own last match, so
     the two numbers could come from two different failures.
- **Decision:**
  1. When anything in the middle was dropped, the head is cut after its last newline and the tail
     starts after its first newline. Every line kept is whole, so every `docker logs --timestamps`
     line keeps its stamp and the merge order holds. Nothing is inserted between the halves. Each
     stream still holds at most the cap (4 MiB). Output within the cap is untouched.
  2. `pathExists` has the same contract as `readFile`: `false` only for `ENOENT`/`ENOTDIR`, a
     rejection for anything else. `LinuxFacts.systemd` is `boolean | null`. A rejected check is
     `null` plus `init-system` in `unknown`, which gives the usual `unknown-fact` blocker. That blocker
     also blocks an adoptable host, as every unread fact does. `init-not-systemd` now has one wording:
     "This system does not run systemd, which the Docker install needs."
  3. `TENSORRT_LLM_DEFAULT_KV_CACHE_FREE_FRACTION`, `TENSORRT_LLM_UNIFIED_KV_CONTEXTS` and
     `tensorrtLlmUnifiedKvMaxTokens` move to `src/runtime/tensorrt-llm/kv-cache.ts`, which both
     `adapter.ts` and `compatibility.ts` import. `compatibility.ts` no longer imports the adapter.
  4. The numbers come from one line (one `torch` message):
     - the last line that reports both numbers;
     - failing that, the last "Tried to allocate" alone, with no free figure borrowed;
     - failing that, the last free figure alone.
- **Consequences:**
  - A line longer than half the cap cannot be kept whole, so that half comes back empty rather than
    as a fragment. A 2 MiB log line is not a realistic pre-ready log.
  - A host whose `/run/systemd/system` cannot even be stat'ed is blocked as an unread fact, even if
    its Docker already works. That is the probe's rule for every fact it could not read.
  - Amends the "one garbled line" consequence of the whole-log record and the "'unknown'" wording of
    the systemd record, both named above.
- **Owner:** `team`
- **Links:** `src/runtime/container/exec.ts` (`HeadAndTail.text`),
  `src/runtime/environment/linux-host.ts` (`exists`), `src/runtime/environment/linux-probe.ts`
  (`LinuxFacts.systemd`), `src/runtime/environment/linux-blockers.ts` (`initNotSystemdBlocker`),
  `src/runtime/tensorrt-llm/kv-cache.ts`, `src/runtime/tensorrt-llm/adapter.ts` (`oomNumbers`),
  `.superpowers/sdd/tasks/review-unverified.md` (the review, git-ignored).
