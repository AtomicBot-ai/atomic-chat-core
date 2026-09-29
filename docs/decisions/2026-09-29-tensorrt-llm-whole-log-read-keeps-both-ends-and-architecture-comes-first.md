---
date: 2026-09-29
title: "tensorrt-llm: the whole-log read keeps both ends, numbers come from the last failure, and an unsupported architecture is named before OOM"
---

# 2026-09-29 — tensorrt-llm: the whole-log read keeps both ends, numbers come from the last failure, and an unsupported architecture is named before OOM

- **Context:** The review of record
  `2026-09-29-tensorrt-llm-kv-cache-fraction-0-8-and-oom-read-from-the-whole-log.md` approved it and
  left six minors:
  1. An excerpt line longer than 500 characters is shortened and ends in `…`, so it never matched the
     tail and was shown twice.
  2. When the tail read failed but the whole-log read worked, the details ended in an empty tail
     under the header "[…] the end of the log:".
  3. The docker exec's cap kept the first 4 MiB of a stream and dropped the rest. A decisive line at
     the end of a longer log was lost. That record's "up to 4 MiB of memory" is per stream: stdout and
     stderr together can hold 8 MiB.
  4. The OOM numbers came from the first "Tried to allocate" / "of which … is free" match in the whole
     log. That could be an earlier, handled failure rather than the one the excerpt ends on.
  5. Three paths had no test: the fallback when `--tail all` fails, a line that only mentions memory
     staying `other`, and a post-ready crash still classifying from the tail.
  6. OOM was checked before unsupported architecture. With the whole log in play, a handled OOM-style
     line plus a real unsupported-architecture crash was labelled OOM.
- **Decision:**
  1. `exitFailureDetails` counts an excerpt line ending in `…` as held when the tail contains it up to
     that mark. With an empty tail, the details are the excerpt alone, with no header.
  2. When only the tail read failed, the lifecycle uses the last `logTailLines` lines of the whole log
     as the tail (`lastLogLines`).
  3. `runDockerCommand` keeps the first half of the cap and a sliding window over the last half, **per
     stream**. They are joined by a newline when anything in between was dropped. Output within the
     cap is returned untouched. Stdout and stderr each still hold at most 4 MiB (8 MiB together).
  4. `classifyOom` takes the numbers from the **last** match of each pattern.
  5. Tests pin the three untested paths.
  6. `classifyTensorrtLlmExit` checks in this order: unsupported architecture, then OOM, then
     unsupported quantization, then `other`. `AutoModelForCausalLM.from_config` raises the architecture
     error before anything is allocated, so it is decisive whatever came earlier in the log. The
     quantization check stays after OOM, as the ruling named only the architecture.
- **Consequences:**
  - A `docker inspect` / `docker info` answer larger than 4 MiB now comes back as head + newline +
    tail instead of head only. It was already unparsable either way, and no answer core reads comes
    near that size.
  - The line at the head/tail seam is two partial lines. For logs, that is one garbled line in the
    middle of a very long log.
  - Amends the "bounded by the 4 MiB cap" wording and the check order in
    `2026-09-29-tensorrt-llm-kv-cache-fraction-0-8-and-oom-read-from-the-whole-log.md`.
- **Owner:** `team`
- **Links:** `src/runtime/container/exec.ts` (`HeadAndTail`), `src/runtime/managed-text/load-policy.ts`
  (`exitFailureDetails`, `lastLogLines`), `src/runtime/managed-text/lifecycle.ts` (`exitFailure`),
  `src/runtime/tensorrt-llm/adapter.ts` (`classifyTensorrtLlmExit`, `classifyOom`),
  `.superpowers/sdd/tasks/review-kvfix.md` (the review, git-ignored).
