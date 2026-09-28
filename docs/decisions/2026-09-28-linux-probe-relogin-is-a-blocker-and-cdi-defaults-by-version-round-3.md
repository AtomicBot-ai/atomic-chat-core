---
date: 2026-09-28
title: "Linux probe fix round 3: relogin is a blocker on every distro, and CDI has a version-based default"
---

# 2026-09-28 — Linux probe fix round 3: relogin is a blocker on every distro, and CDI has a version-based default

- **Context:** Task 2.4 fix round 3 (`findings-2.4-r3.md`) is the last round with this implementer;
  the controller asked for it to be airtight. One Important finding remained open from round 2 (Arch
  could never actually reach the `docker-group-manual` outcome round 2 added, because Arch's own
  `docker` package is not one `dpkg-query`/`rpm -q` ever see, so `install_method` stayed `null` and
  the `readyExceptAccess` gate never fired there — a real regression against the pre-round-2
  behavior, where Arch at least adopted a working host). Two more concrete bugs: a `daemon.json` read
  error (`EACCES` on a locked-down file) was folded into the same `null` as "the file does not exist"
  by a blanket `.catch(() => null)`, so a permission-denied read looked like "nothing configured yet"
  and could still schedule `nvidia-ctk runtime configure`; and `getent`'s own exit `2` ("no such
  key" — the `docker` group does not exist on this system at all, a real answer) was being folded
  into the generic "`getent` could not answer" `'unknown'` case from round 2's own fix, when it
  should have been a confident `false`. On top of these, two controller rulings changed behavior the
  previous two rounds' ADRs describe: `configured && !effective` no longer produces an empty
  `LinuxInstallPlan` (round 2's "relogin only" outcome); and CDI's default-enabled state on Docker
  28.2+ is now version-derived, not only `daemon.json`'s explicit `features.cdi`.
- **Decision:**
  - **Ruling 4 — relogin is a blocker, not a plan, on every distribution.** `assessLinux` now checks
    `docker_group.configured === true && !effective` unconditionally, right after the `dockerReady`
    check and before `readyExceptAccess`, `distroBlocksAutoInstall`, or any other distro-specific
    gating runs — it applies to Arch and Silverblue exactly as it applies to Ubuntu, because logging
    back in is either the whole fix or (when the group is already `effective` too,
    `docker-access-unexplained`) provably not the fix, regardless of what this distribution's install
    recipe otherwise supports. This supersedes round 2's design (`docs/decisions/2026-09-28-linux-
    probe-restores-docker-group-diagnostics-round-1.md` as amended by round 2's own record): what was
    an empty `LinuxInstallPlan { system_changes: [] }` is now a `relogin-required` blocker with
    `commands: []`. One deliberate consequence, called out explicitly rather than hidden: this check
    does not require `toolkit_installed` or any other "ready except access" precondition, so a host
    that is *also* missing the toolkit still gets told to relogin first — the toolkit gap surfaces on
    the next probe, after the relogin, rather than being enumerated up front. The controller's ruling
    text states this unconditionally ("on any distro"), and no reading of it carves out an exception
    for "unless something else is also known to be missing."
  - **Ruling 1 fix — Arch reaches the group-only outcomes it was supposed to.** `assessLinux` gained
    `dockerInstallRecognised(facts, distribution)`: `install_method !== null`, or — new —
    `distribution.family === 'pacman' && facts.docker.cli`. This is the simpler of the two options the
    finding offered (the other being teaching `detectDockerInstallMethod` a `pacman -Q docker` call);
    it was chosen because it needed no change to that distribution-agnostic function or its signature,
    confines the Arch-specific knowledge to the one place that already has `distribution` in scope,
    and keeps `detectDockerInstallMethod`'s own contract ("Arch is not resolved here at all") intact
    and documented rather than quietly widened.
  - **Ruling 5 — CDI counts as enabled by Docker's own 28.2+ default.** A new `engine_version` fact
    (`DockerFacts.engine_version`) is read from the package database alone — `dpkg-query`'s own
    `${Version}` field (the format string gained a third column for it), `rpm -q`'s existing
    name-version-release string, or a new read-only `pacman -Q docker` call, tried in that order
    (`detectEngineVersion`) — independent of daemon reachability, since it is needed precisely when
    the daemon cannot be reached. `cdiEnabledByDefault(engineVersion, explicitFeaturesCdi)`:
    `daemon.json`'s explicit `features.cdi` always wins when present (`true` or `false`); otherwise a
    *known* version ≥ 28.2.0 counts as enabled; an unknown version keeps requiring the explicit
    setting rather than assuming "recent enough." This supersedes round 2's `daemonJsonHasCdiEnabled`
    (boolean-only, explicit-`true`-or-nothing) with a three-way `daemonJsonFeaturesCdi` (`true` /
    `false` / `undefined`) feeding the version-aware combinator.
  - **Item 2 fix — a real read error is `'unreadable'`, never folded into `'not-configured'`.**
    `daemonJsonNvidiaRuntimeEvidence` (and `daemonJsonFeaturesCdi`) now take a `{ text, unreadable }`
    pair instead of a bare `string | null`; `probeLinux` computes it with a new `readDaemonJson`
    helper that only reports `unreadable: false` when `readFile` itself resolves `null` (this repo's
    convention for "not there") — a `readFile` that *rejects* (an `EACCES` on a `0600` file, in the
    real implementation this deps interface stands in for) is `unreadable: true`. The
    `daemon-json-unreadable` blocker in `assessLinux` also lost its `!daemon_reachable` guard: a
    reachable daemon that already answered "no nvidia runtime" from `docker info` directly does not
    *need* `daemon.json` to make that call, but an unreadable one right next to it is still a sign of
    a locked-down or unusual configuration this integration should not write into blind.
  - **Ruling 7 fix — `getent` exit `2` is a real `false`.** `parseDockerGroup` now special-cases
    `groupEntry.code === 2` (`getent`'s own "no such key") as `configured: effective` (a confident
    answer, only overridden by `effective` itself already being true some other contradictory way) —
    distinct from every other `getent` failure, which still falls back to `'unknown'` per round 2.
  - **Ruling 6 — rpm-ostree's group-only commands gain a step.** `groupOnlyCommands(immutableOs,
    user)` (new, in `linux-blockers.ts` alongside the blocker constructors that use it) prepends
    `grep -E '^docker:' /usr/lib/group | sudo tee -a /etc/group` before the `usermod` line on an
    immutable-OS host: rpm-ostree's package layering writes the `docker` group into `/usr/lib/group`
    (the vendor/OS-tree database), which `/etc/group` — what `usermod`/`getent` actually consult —
    does not inherit automatically, so `usermod -aG docker` alone would fail outright there.
  - **Ruling 8 — exact-account commands, root-aware.** `archCommands(user)` (also moved to
    `linux-blockers.ts`) now takes the probed account and appends `sudo usermod -aG docker <user>`
    only when that account is not `root` — replacing the literal `$USER` placeholder round 1 shipped,
    and closing the same "never tell root to join a group it does not need" rule design D4 already
    established elsewhere in this module.
  - **File split, again.** `linux-plan.ts` passed ~500 lines once more implementing the above;
    `effectiveGpuRuntime`, `archCommands` and `groupOnlyCommands` moved to `linux-blockers.ts` (which
    already held the blocker constructors that are their only real callers), trimming it back down.
    `buildInstallPlan` and its types stayed in `linux-plan.ts` — splitting it out further would need
    `LinuxAssessmentOptions` moved to a third, shared file to avoid a circular import between
    `linux-plan.ts` and wherever `buildInstallPlan` landed, which was judged not worth the risk this
    late, on working code, for a few dozen lines.
- **Consequences:** Every scenario in `linux-plan.test.ts` that used to expect an empty
  `LinuxInstallPlan` for a stale-session host now expects a `relogin-required` blocker instead —
  anything downstream (task 2.6) that was planning to render "nothing to approve, just relogin" from
  a plan with empty `system_changes` must read it from the blocker list instead. `engine_version` and
  the `{ text, unreadable }` read shape are both new surface any caller of
  `daemonJsonNvidiaRuntimeEvidence`/`daemonJsonFeaturesCdi` directly (rather than through
  `probeLinux`) needs to adopt. Arch still cannot reach `docker-group-manual` through a *literal*
  `install_method` match — only through the `family === 'pacman' && cli` special case — so a future
  change to how Arch's package state is read (e.g. adding real `pacman -Q docker` recognition to
  `detectDockerInstallMethod`) should retire `dockerInstallRecognised`'s special case rather than
  stack a second one on top of it.
- **Owner:** team.
- **Links:** `.superpowers/sdd/tasks/findings-2.4-r3.md` (items 1–3, rulings 4–8); supersedes the
  "relogin only" `LinuxInstallPlan` outcome and the `daemonJsonHasCdiEnabled` design of
  `docs/decisions/2026-09-28-linux-probe-tightens-ready-except-access-round-2.md`; openspec change
  `add-tensorrt-llm-linux`, spec `managed-runtime-environment`, design D2/D4/D5;
  `src/runtime/environment/linux-probe.ts`, `src/runtime/environment/linux-docker-facts.ts`,
  `src/runtime/environment/linux-plan.ts`, `src/runtime/environment/linux-blockers.ts`.

<!--
Supersedes: 2026-09-28-linux-probe-tightens-ready-except-access-round-2.md
-->
