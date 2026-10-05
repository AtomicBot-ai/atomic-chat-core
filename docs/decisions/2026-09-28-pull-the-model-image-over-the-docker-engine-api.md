---
date: 2026-09-28
title: "Pull the model image over the Docker Engine API, not `docker pull`"
---

# 2026-09-28 — Pull the model image over the Docker Engine API, not `docker pull`

- **Context:** Task 2.8 (openspec change `add-tensorrt-llm-linux`, spec `tensorrt-llm-runtime`,
  requirement "Долгий первый старт"/"Этапы и таймаут загрузки") needs byte-level progress while
  pulling the `tensorrt-llm` image, which the curated descriptor puts at roughly 21 GB
  (`download_bytes`, `test/fixtures/runtimes/tensorrt-llm.json`). The obvious approach — spawn
  `docker pull <repository>@<digest>` through the same argv-only `DockerExec` every other operation
  in `src/runtime/container/` uses — does not have the data: `docker pull`'s progress bars are
  written by a TTY-aware renderer (`distribution/pull.go` in the CLI's own source), and without a
  TTY attached (exactly the situation a `spawn` with piped stdio is always in) the CLI prints only
  per-layer one-line status updates with no byte counts, or nothing at all depending on version. A
  user would watch an ~21 GB download with no way to tell it apart from a hang.
- **Decision:** Pull by `repository@digest` through the Docker Engine API directly, over the same
  system unix socket (`/var/run/docker.sock`) every other operation is forced onto:
  `node:http`'s `socketPath` option, `POST /images/create?fromImage=<repo>&tag=<digest>`. The
  daemon's response is a stream of newline-delimited JSON objects, one per layer per progress tick,
  each with a `progressDetail.current`/`.total`; `pull.ts` parses that stream and aggregates every
  layer's numbers into a single running total, handed to an injected `onProgress({current, total})`
  callback. This is the one operation in the module that does not go through `argv.ts`/`exec.ts`'s
  `DockerExec` — there is no CLI subcommand that streams byte counts, so there is no argv to build.
  `repository` and `digest` still go through `argv.ts`'s `assertSafeArgvValue`/`assertDigest` before
  being placed in the request's query string, even though there is no shell or argv here to inject
  into: they are still descriptor-derived values crossing a trust boundary, and reusing the same
  guard keeps that boundary in one place rather than two. Tested against a fake Docker Engine API — a
  real `http.Server` listening on a unix socket inside a fresh temp directory (`mkdtempSync`), never
  a real Docker daemon — asserting the request shape, the progress aggregation across layers
  (including a layer that reports twice and a status-only line that reports nothing), and rejection
  with `AtomicCoreError('IO_ERROR', ...)` on a non-200 response, an `{"error": ...}` line mid-stream,
  and an unreachable socket.
- **Consequences:** `pullImage` is the only function in `src/runtime/container/` that talks `node:http`
  instead of spawning `docker`; a reader expecting every operation to share one `DockerExec` shape
  should look here first. The Engine API's exact JSON shape (`progressDetail`, per-layer `id`) is now
  a second surface this module depends on beyond the CLI's own argv/exit-code contract — a Docker
  Engine major version bump that changes `/images/create`'s stream format would need to be caught
  here, not in `argv.ts`. Byte progress is best-effort: a layer that never reports `progressDetail`
  (e.g. "Already exists") contributes nothing to the total, so the aggregate can under-report until
  every layer has reported at least once — acceptable for a progress indicator, not for anything that
  needs to be exact.

  Separately, recording a small T01e follow-up here rather than in a second tiny ADR: task 2.7's
  `PreparedLaunch` (`src/runtime/managed-text/types.ts`) already carries the `BackendTarget` this
  executor's container ends up reachable at, constructed from the same `HostPublication` this
  module's `buildCreateModelContainerArgv` turns into the container's `-p` flag
  (`src/runtime/container/argv.ts`). Task 2.8 did not change that shape — it is exactly the "the
  executor resolves `BackendTarget`" boundary ADR
  `docs/decisions/2026-09-23-preserve-deployment-seams.md` names, and 2.7's report already flagged it
  as a judgment call for this task to weigh in on. This task's `ModelContainerCreateSpec.publication`
  parameter is that same `HostPublication`, unmodified; nothing about the create argv needed a
  different shape, so the review question from 2.7's report is resolved by leaving it as is.
- **Owner:** team.
- **Links:** openspec change `add-tensorrt-llm-linux`, spec `tensorrt-llm-runtime`; task brief
  `.superpowers/sdd/tasks/task-2.8-brief.md`; `src/runtime/container/pull.ts`,
  `src/runtime/container/pull.test.ts`, `src/runtime/container/argv.ts`;
  `docs/decisions/2026-09-23-preserve-deployment-seams.md` (ADR T01e);
  `.superpowers/sdd/tasks/task-2.7-report.md`.
