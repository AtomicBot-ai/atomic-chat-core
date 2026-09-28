---
date: 2026-09-28
title: "Host-step executor fix round 3: live Obsoletes check, /proc/self/fd folder pinning"
---

# 2026-09-28 — Host-step executor fix round 3: live Obsoletes check, /proc/self/fd folder pinning

- **Context:** Re-review of round 2 (`2026-09-28-host-step-executor-fix-round-2.md`), with the dnf4
  and dnf5 sources read. `--setopt=obsoletes=False` does not stop RPM `Obsoletes` replacement: libdnf
  (`Goal.cpp`) and libdnf5 (`goal_private.cpp`) set `SOLVER_FLAG_YUM_OBSOLETES` unconditionally; the
  option only affects candidate selection. Round 2's claim — and its allowlist requirement — gave
  protection that did not exist. The residual result-path race was also still open.
- **Decision:** (supersedes round 2, decision 1(b) and its residual-race sentence)
  1. The `--setopt=obsoletes=False` flag and its allowlist requirement are removed. The static
     per-component conflict list stays. A live, read-only check runs before every dnf install: for each
     package still to install, `dnf repoquery --quiet -y --obsoletes <package>` (one capability per
     line; the version constraint is dropped, so any installed version counts), then for each
     capability `rpm --query --whatprovides --queryformat=%{NAME}\n <capability>`. Any installed
     provider other than the recipe's own packages (containerd.io provides and obsoletes `containerd`)
     refuses the install with "nothing installed, nothing removed". A repoquery failure or an output
     line that is not a capability also fails the step. The allowlist permits exactly these shapes:
     `dnf repoquery --quiet -y --obsoletes <one of the recipe's packages>`, `rpm --query --quiet <name>`
     and `rpm --query --whatprovides --queryformat=%{NAME}\n <capability>`. `-y` on the repoquery only
     lets dnf import the repository key this recipe pinned and wrote, as the install would.
  2. The request/result folder is opened `O_DIRECTORY | O_NOFOLLOW`, checked through the handle
     (fstat: real directory, trusted owner, not group/world-writable), and every file in it is then
     addressed as `/proc/self/fd/<fd>/<name>` — the temporary `O_EXCL` open, the request open and the
     `rename`. A later swap of the folder's path changes nothing. Where `/proc` is not mounted the
     executor falls back to the checked path, and the race of round 2 returns there only.
  3. After a timed-out command answers, `hostExec` destroys its ends of the child's pipes, so a
     grandchild holding them cannot keep the root process alive.
  4. `host-step exec` exits 2 whenever no result file was written — a refused path or folder, or a
     failed write (ENOSPC, EROFS, ENOENT) — with the reason on stderr.
  5. Text: older docker-ce releases (not current ones) obsolete `docker-ce-selinux`. A root caller that
     still carries `SUDO_UID`/`PKEXEC_UID` is treated as acting for that uid: it must `chown` the
     host-steps folder to that uid or clear both variables.
- **Consequences:** a dnf install now needs repository metadata before it runs (the repoquery), which
  dnf would fetch for the install anyway. `recipe_digest` changed (pinned test updated). The live check
  is conservative: an installed provider of an obsoleted capability is refused even when its version
  lies outside the Obsoletes constraint. Real dnf behaviour (repoquery output format on dnf5, key
  import with `-y`) is verified by the live test (2.18), not by unit tests.
- **Owner:** `team`.
- **Links:** `src/host/recipes/{install-container-runtime,executor,executor-io,request-file}.ts`,
  `src/runtime/environment/host-exec.ts`, `src/cli/commands/host-step.ts`; findings `task 2.5 r3`.
