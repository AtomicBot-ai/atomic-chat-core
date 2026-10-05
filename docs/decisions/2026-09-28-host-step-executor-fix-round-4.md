---
date: 2026-09-28
title: "Host-step executor fix round 4: name-only, fail-closed package queries"
---

# 2026-09-28 — Host-step executor fix round 4: name-only, fail-closed package queries

- **Context:** Re-review of round 3 (`2026-09-28-host-step-executor-fix-round-3.md`). Three flaws in
  round 3's live Obsoletes check:
  - it read any non-zero `rpm` exit as "not provided", so an rpm database that could not be opened
    let a conflict through (fail-open); the presence query had the same flaw;
  - it asked `rpm --whatprovides`, but libsolv matches Obsoletes against package names only (no
    `POOL_FLAG_OBSOLETEUSESPROVIDES`), so nvidia-container-toolkit-base, which provides
    `nvidia-container-runtime` without being named that, would be refused for nothing;
  - its repoquery could skip an unreadable repository and answer "nothing obsoleted" with exit 0.

  Round 3 also called the repoquery "read-only", which it is not quite.
- **Decision:** (supersedes round 3, decision 1: its rpm command shapes, its exclusion of the
  recipe's own packages, and its `-y` sentence)
  1. Every rpm package query, the presence check included, is
     `rpm --query --queryformat=%{NAME}\n <name>`. It is name-only and has no `--quiet`, which would
     hide rpm's answer. It is the only rpm shape the allowlist permits, and the name must be a package
     name. The live check asks it for each name that `dnf repoquery --obsoletes` prints. The name is
     the first word of each line, and a line whose first word is not a package name fails the step.
     The exclusion of the recipe's own packages is removed. With name-only queries it is no longer
     needed: `rpm --query containerd` does not see containerd.io. It was also unsound: it would have
     ignored a real replacement.
  2. A package query fails closed. A package counts as absent only in these two cases:
     - rpm exits 1 with exactly `package <name> is not installed` on stdout and nothing on stderr;
     - `dpkg-query` exits 1 with exactly `dpkg-query: no packages found matching <name>` on stderr
       and nothing on stdout.

     `LC_ALL=C` fixes the wording. Any other answer fails the step before anything is installed:
     an rpmdb-open error, a command that did not run, or an unrecognised reply.
  3. The repoquery is `dnf repoquery --quiet -y --setopt=skip_if_unavailable=False --obsoletes
     <recipe package>`. The allowlist requires the setopt.
  4. The repoquery is not read-only. It refreshes dnf's metadata cache. With `-y`, it also accepts
     the signing-key import of every enabled repository with `repo_gpgcheck` on (dnf4
     `CliKeyImport`, dnf5 `context.cpp`). These are the same keys and the same prompt the install
     itself answers. Only the recipe's named packages are queried; the dependencies an install
     pulls in are not. nvidia-container-toolkit-base, which the toolkit requires, carries the same
     Obsoletes as the toolkit.
  5. `hostExec` also releases its ends of the child's pipes on the timeout path without a grace
     period, as it already did with one.
- **Consequences:**
  - `recipe_digest` changed; the pinned test is updated.
  - A host whose rpm or dpkg database cannot be read now gets a failed step instead of an install.
  - Not a removal: `docker-ce` requires `containerd.io >= X`, so an older installed containerd.io may
    be upgraded by the install. The spec allows that ("не обновлять … сверх необходимого для
    устанавливаемых"); it is an upgrade the install needs, and nothing is removed.
  - What real rpm/dpkg print is taken from their sources and verified by the live test (2.18).
- **Owner:** `team`.
- **Links:** `src/host/recipes/{install-container-runtime,executor}.ts`,
  `src/runtime/environment/host-exec.ts`; findings `task 2.5 r4`.
