---
date: 2026-09-28
title: "Host-step executor fix round 1: trusted folders, --no-remove, own-property lookups"
---

# 2026-09-28 — Host-step executor fix round 1: trusted folders, --no-remove, own-property lookups

- **Context:** Review of task 2.5
  (`2026-09-28-host-step-executor-runs-the-container-runtime-recipe-in-core.md`) found holes in the code
  that runs as root: a path-based `chmod` after writing into a user-owned folder, `apt-get install`
  able to remove packages through its resolver, distribution/release lookups that walked
  `Object.prototype`, and a request file whose owner and mode were never checked.
- **Decision:**
  1. Files the executor reads or writes in the user's folder are trusted only if that folder is a real
     directory (lstat, not a symlink) owned by root or the invoking user (`PKEXEC_UID`/`SUDO_UID`) and
     not group- or world-writable. The request must be, on its open handle, a regular file with the same
     owner/mode rule, opened `O_NOFOLLOW | O_NONBLOCK`. Every file root writes is created
     `O_CREAT | O_EXCL | O_NOFOLLOW`, `fchmod`-ed on the handle before close, and renamed into place.
     No `seteuid` (controller ruling). A request whose `step_id` differs from its file name is refused.
  2. `apt-get install` always carries `--no-remove` (and `-o DPkg::Lock::Timeout=300`), and
     `assertPermittedCommand` refuses an `apt-get install` without it. `dnf install` never removes an
     installed package without `--allowerasing` (dnf4 and dnf5), which is now a forbidden word. The
     Fedora conflict list is Docker's full list.
  3. Recipe tables are read through own properties only (`Object.hasOwn`), including the command
     allowlist.
  4. Package installs run with a 2-hour deadline and SIGTERM, then 5 minutes, then SIGKILL
     (`hostExec`'s new `terminateGraceMs`); other commands keep a 10-minute SIGKILL deadline.
  5. Every refusal is an `AtomicCoreError` (`MANAGED_HOST_STEP_INVALID`; `MANAGED_METADATA_INVALID` for a
     bad vendor key); refusal text is bounded to 2000 characters; the Docker probe runs inside the
     first step, and any unexpected error still produces a result file.
  6. **What `recipe_digest` covers:** everything in `INSTALL_CONTAINER_RUNTIME_RECIPE` — argv templates,
     paths, URLs, key fingerprints, file bodies, modes, the command environment, the conflict lists.
     It does **not** cover builder or executor code: step ids and order, `VENDOR_IDS`, `PERMITTED`,
     the check-then-act logic and the restart rule. Changing those is an ordinary code change and does
     not by itself invalidate approved plans.
- **Consequences:** clients must create the host-steps folder and the request file so that nobody but
  the user can write them — e.g. folder `0700`, file `0600` — because under the common desktop umask
  `002` the defaults are group-writable and the executor will refuse them. A request run by root with
  neither `PKEXEC_UID` nor `SUDO_UID` is accepted only from a root-owned folder. `recipe_digest` changed
  (pinned test updated). Residual risk: without `openat`, the folder is checked by path; its owner could
  swap it between check and open, which can only create a new `*.result.json`/temporary file elsewhere,
  never overwrite one.
- **Owner:** `team`.
- **Links:** `src/host/recipes/{executor-io,executor,install-container-runtime,openpgp}.ts`,
  `src/runtime/environment/host-exec.ts`; findings `task 2.5 r1`.

<!--
Supersedes: nothing; amends 2026-09-28-host-step-executor-runs-the-container-runtime-recipe-in-core.md
-->
