---
date: 2026-09-28
title: "Host-step executor fix round 2: dnf Obsoletes, user-owned folders only, bounded kill"
---

# 2026-09-28 — Host-step executor fix round 2: dnf Obsoletes, user-owned folders only, bounded kill

- **Context:** Re-review of task 2.5 round 1 (`2026-09-28-host-step-executor-fix-round-1.md`). That
  record said `dnf install` never removes an installed package without `--allowerasing`. That is
  wrong: a plain `dnf install` honours RPM `Obsoletes` and replaces the obsoleted package —
  containerd.io obsoletes `containerd` and `runc`, docker-ce obsoletes `docker-ce-selinux`, and
  nvidia-container-toolkit obsoletes `nvidia-container-runtime` (≤ 3.5.0-1) and
  `nvidia-container-runtime-hook` (≤ 1.4.0-2). The round-1 residual-race text was also wrong about
  `rename`, and a root-owned folder was still trusted for the request/result when a user was known.
- **Decision:** (supersedes the dnf sentence of round 1, item 2, and its residual-race sentence)
  1. Both layers, per controller ruling: every `dnf install` carries `--setopt=obsoletes=False`, and
     `assertPermittedCommand` refuses a `dnf install` without it; and the obsoleted packages are on the
     dnf conflict lists, now kept per component — `docker-engine`: Docker's twelve plus `containerd`,
     `runc`, `docker-ce-selinux`; `nvidia-container-toolkit`: `nvidia-container-runtime`,
     `nvidia-container-runtime-hook`. The pre-check runs for every component that still has a package
     to install, so the toolkit-only path (e.g. on a moby-engine host) is checked too; an installed
     conflicting package fails the step with "nothing installed, nothing removed".
  2. With `PKEXEC_UID`/`SUDO_UID` known, only a folder that user owns is trusted for the request and
     the result — never a root-owned one — so `host-step exec /etc/<dir>/<x>.request.json` cannot
     make root write a result into a system folder. System files are written only into root-owned
     folders nobody else can write. Residual race, stated correctly: without `openat`, the folder's
     owner can swap it for a link between check and `rename`; since `rename` replaces an existing
     destination, root can be made to create or replace a `<step_id>.result.json` (0644, our JSON) in
     the link's target folder. No other file name is reachable.
  3. `hostExec` with `terminateGraceMs`: after SIGTERM the answer comes on `exit` (plus 1 s for the
     pipes) or at the latest 5 s after SIGKILL, never only on `close`, which a grandchild holding the
     pipes can delay forever — so a result file is always written.
  4. Client requirement documented in `request-file.ts` and on `executeHostStep`: folder `0700` owned
     by the user, request `0600`. Exit code 2 of `host-step exec` means "refused before a result file
     could be written", with the reason on stderr.
- **Consequences:** `recipe_digest` changed again (pinned test updated). A Fedora host with any of
  the obsoleted packages installed gets a failed step with the package named instead of a silent
  replacement. The app (3.5) and `atc` must follow the folder/file modes and must treat exit 2 with
  no result file as a failure.
- **Owner:** `team`.
- **Links:** `src/host/recipes/{install-container-runtime,executor,executor-io,request-file}.ts`,
  `src/runtime/environment/host-exec.ts`, `src/cli/commands/host-step.ts`; findings `task 2.5 r2`.
