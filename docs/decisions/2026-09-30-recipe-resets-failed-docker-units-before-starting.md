---
date: 2026-09-30
title: "The recipe runs systemctl reset-failed before starting or restarting Docker"
---

# 2026-09-30 — The recipe runs systemctl reset-failed before starting or restarting Docker

- **Context:** after the failed start of F-4 (3.10 acceptance run, finding F-6), the host was half
  configured: `daemon.json` registered the `nvidia` runtime, `docker.service` and `docker.socket` were
  `failed` with `start-limit-hit`, and the user was not in `docker`. A retry of the same step would hit
  systemd's refusal to start the unit again, not the original cause.
- **Decision:** (owner ruling R-core-10.) Right before `systemctl enable --now docker` and before the
  approved `systemctl restart docker`, the executor runs
  `systemctl reset-failed docker.service docker.socket`. It is argv only, and its exit status is
  ignored, because on a unit that is not failed it does nothing. It runs only when the step is about to
  start Docker. A satisfied step (Docker enabled and active) never runs it. Every step already checks
  before it acts, so on a retry the keys, sources, packages, the registered runtime and the CDI spec
  report `satisfied`.
- **Consequences:** a retry after the cause is fixed (the VPN off, `bip` set) completes in one more
  elevation. The command is in the recipe data, so the recipe digest covers it. The allowlist permits
  exactly this argv and no other `reset-failed`.
- **Owner:** `team`
- **Links:** task 2.23 (F-6), `manual-test-3.10.md`, `rulings/core.md` R-core-10;
  `src/host/recipes/install-container-runtime.ts`, `executor.ts` (`resetFailed`), `executor.test.ts`
  ("a retry on a half-configured host").
