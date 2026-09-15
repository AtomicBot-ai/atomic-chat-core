---
date: 2026-09-15
title: "Serialize owner lifecycle and preserve serve flags"
---

# 2026-09-15 — Serialize owner lifecycle and preserve serve flags

- **Context:** The first phase-1 implementation let shutdown race a model load, replaced the public
  listener by stopping it before the replacement had bound, and treated a losing concurrent daemon
  launcher as a failed CLI command. It also accepted only part of the Rust `jan-cli serve` surface,
  so existing scripts lost flags during the owner migration.
- **Decision:** The core has explicit running/stopping/stopped states. New work is refused once
  stopping begins; in-flight startup is cancelled and its child terminated; sessions are drained
  before control and the instance lock are released. Public start/stop transitions are serialized:
  an identical start is idempotent and an incompatible start returns `CORE_ALREADY_RUNNING` without
  touching the live listener. Concurrent CLI launchers converge on whichever daemon acquired the
  data-folder lock.
- **CLI compatibility:** `serve` retains the Rust flags and defaults for model/backend paths,
  projector, embedding, readiness timeout, GPU layers, context, fit, threads, API key, detach,
  logging, verbosity, quantization selection, data folder and JSON output. `owner/repository` may be
  fetched from Hugging Face; `HF_TOKEN` takes precedence over `HUGGING_FACE_HUB_TOKEN`, the default
  file is `Q4_K_XL` or otherwise the largest, and `model.yml` is written only after size/sha256
  validation. `--detach` is accepted but does not fork another model owner: phase 1 already uses a
  persistent daemon. It selects the default log path instead.
- **Rejected:** Replacing a live public listener in place, because bind failure would create an
  avoidable outage; allowing loads to finish after lock release, because the resulting process has
  no accountable owner; and duplicating the Rust one-shot detach process, because that breaks the
  single-owner invariant.
- **Consequences:** Changing public host/port/key now requires an explicit stop followed by start.
  A shutdown can wait for child termination, but never publishes a late session. The CLI has a
  deliberate ownership difference from the Rust binary while preserving its input surface. Model
  downloads use the shared Atomic Chat model tree and the existing resumable downloader.
- **Owner:** team
- **Links:** `src/core.ts`, `src/runtime/llamacpp/runtime.ts`, `src/cli/`, `src/models/hf.ts`,
  PLAN.md §3.4–3.6 and §4 phase 1.
