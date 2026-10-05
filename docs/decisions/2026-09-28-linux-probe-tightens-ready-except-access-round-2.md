---
date: 2026-09-28
title: "Linux probe fix round 2: docker info's exit code is not proof, and relogin-only needs real evidence"
---

# 2026-09-28 — Linux probe fix round 2: docker info's exit code is not proof, and relogin-only needs real evidence

- **Context:** Task 2.4 fix round 2 (`findings-2.4-r2.md`) found a real-world bug by reading the
  actual `docker`/`cli` source for v24–v28.2: on those versions (which is what Debian/Ubuntu's
  `docker.io` and Fedora's `moby-engine` 27.x — both on the recipe list — actually ship),
  `docker info --format '{{json .}}'` exits `0` and prints a fully-templated JSON document even when
  the `Info()` call itself failed; the real error lands in `ServerErrors` while `ID`/`ServerVersion`
  and everything else are the Go zero value. `parseDockerInfo` trusted `output.code === 0` as proof
  of a real answer, so a `docker.io` host that plainly refused a connection read as reachable — which
  broke both the round-1 "relogin only" branch (item 2, `linux-plan.ts`) and runtime-config planning
  (a blind `configure-nvidia-runtime` next to a runtime that might already be fine, or a `docker info`
  answer treated as authoritative when it was not one at all). Two more Important findings arrived
  alongside it: the round-1 Desktop-detection fix (task 2.4 fix round 1 ADR) still blocked a working
  Desktop+Engine host because the package check ran before the engine checks, and the round-1
  "relogin only" branch bypassed Arch/immutable/recipe gating entirely and could hide a missing
  toolkit behind an apparently harmless empty plan.
- **Decision:**
  - `parseDockerInfo` (`linux-docker-facts.ts`) now reads a `code === 0` response with a non-empty
    `ServerErrors` *and* an empty `ServerVersion` as unreachable, the same as a non-zero exit —
    carrying `server_errors` through so the reason is still visible. An empty `DockerRootDir`/`ID`
    is now `null`, not the literal string `""`, closing a second instance of the same "empty string
    is not a real answer" bug.
  - The round-1 "relogin only" branch is replaced by a single `readyExceptAccess` gate in
    `assessLinux`: `docker.cli && toolkit_installed && install_method !== null &&
    effectiveGpuRuntime(facts) && service_active === true && !daemon_reachable`. Only inside that gate
    does the branch even consider itself — everything else (toolkit missing, runtime not confirmed
    configured, service not active) now falls straight through to the ordinary distro-gated
    install-plan path, so a missing toolkit is never hidden behind a "just relogin" plan again (item
    5). Inside the gate, `docker_group` (now consulted again, still never for `dockerReady` itself)
    decides among four outcomes: `configured === true && !effective` is the pure relogin wait (empty
    plan); `configured === true && effective` is a new `docker-access-unexplained` blocker — group
    membership already applies to this very session, so relogin cannot be the fix, and this module has
    no further diagnosis to offer (item 2's core complaint: the old branch could not tell this case
    apart from a genuine stale session, so it would have looped a person into logging in and out
    forever); `currentUser === 'root'` gets the same unexplained blocker, never a proposal to add root
    to a group it does not need (design D4, item 9); anything else (not configured, or `'unknown'`)
    either gets a minimal one-line plan (just the group add) when the distribution would otherwise
    qualify for automatic install, or a new targeted `docker-group-manual` blocker with the exact
    `usermod` command when it would not (Arch, an immutable base, or an unqualified distribution,
    item 5) — never a silent elevated plan on a host this integration does not auto-install on.
  - `DockerGroupFacts.configured` is now `boolean | 'unknown'`: `getent group docker` failing (not
    installed, or genuinely absent) no longer reads as a confident "not a member" — only this
    session's own groups (`id -nG`, always a real answer on its own) can positively confirm
    membership without it (item 9).
  - Offline GPU-runtime evidence (`gpu_runtime_from_config`, used whenever the daemon cannot be
    reached) is now three-way at the source: `daemonJsonNvidiaRuntimeEvidence` returns `'configured'`
    / `'not-configured'` / `'unreadable'`, and a `daemon.json` that exists but will not parse blocks
    with a new `daemon-json-unreadable` reason instead of silently planning `nvidia-ctk runtime
    configure` next to a file this probe cannot even read back (item 6). The CDI half of that same
    offline evidence now also requires `daemon.json`'s `features.cdi: true`, mirroring the live path's
    own `CDISpecDirs` requirement — a device `nvidia-ctk cdi list` can see is not evidence Docker
    itself is configured to use it (item 7).
  - `detectDockerInstallMethod` (`linux-docker-facts.ts`) reorders Desktop detection: `info.desktop`
    (the daemon that actually answered says so) is checked first and always wins; the `docker-desktop`
    *package* only counts when the system socket did not answer at all and no recognised engine
    package (`docker-ce`/`moby-engine`/`docker.io`) is also installed — fixing the round-1 regression
    where a Desktop package installed alongside a working `docker-ce` blocked a perfectly good host
    (item 4). The same function also gained a `serviceActive` parameter: a leftover
    `$XDG_RUNTIME_DIR/docker.sock` only counts as rootless evidence when `docker.service` is not
    active either — a confirmed-running service explains an unreachable socket (including the ≤28.2
    bug this round fixes) better than a stray file from an abandoned setup (item 8).
  - `host-exec.ts`'s `hostExec` now accepts the same per-call `env` overlay `LinuxProbeDeps.exec`
    documents, merging it onto `process.env` (or the instance's configured base) rather than
    replacing it — closing the gap between what the interface's doc comment promised and what the one
    real implementation in this repo actually did (item 10).
  - Socket-activated Docker (`docker.socket` active, `docker.service` itself only starting on first
    connection) is a known, documented gap, not fixed here: `parseServiceActive`'s doc comment now
    describes exactly what a second `systemctl is-active docker.socket` call would need to change and
    why it is left for task 2.6, which will decide it against the real wiring rather than a guess made
    here (the finding explicitly offered "implement it or document it for 2.6").
- **Consequences:** Arch cannot reach the targeted `docker-group-manual` blocker at all today — its
  own `docker` package is not one of `DOCKER_PACKAGE_CANDIDATES` (there is exactly one common source
  there, unlike Debian/Fedora's several), so `install_method` stays `null` and `readyExceptAccess`
  never triggers; an Arch host missing only its group membership falls through to the existing full
  `arch-manual-install` blocker instead, which is safe (it already includes the `usermod` command) but
  less tailored. Teaching `detectDockerInstallMethod` about a distribution's own package name would
  require passing it the distribution, which it does not take today — left for whoever next touches
  Arch package detection, documented in `linux-plan.test.ts`'s own test for this case rather than
  silently worked around. Anything reading `docker_group.configured` must handle `'unknown'`
  explicitly now; treating it as `false` reintroduces exactly the bug item 9 closed.
- **Owner:** team.
- **Links:** `.superpowers/sdd/tasks/findings-2.4-r2.md` (items 1–10); supersedes the relevant claims
  of `2026-09-28-linux-probe-restores-docker-group-diagnostics-round-1.md` (the "relogin only" branch
  it introduced, and its `-H`-flag-is-enough env reasoning); openspec change `add-tensorrt-llm-linux`,
  spec `managed-runtime-environment`, design D2/D4/D5; `src/runtime/environment/linux-probe.ts`,
  `src/runtime/environment/linux-docker-facts.ts`, `src/runtime/environment/linux-plan.ts`,
  `src/runtime/environment/host-exec.ts`.

<!--
Supersedes: 2026-09-28-linux-probe-restores-docker-group-diagnostics-round-1.md
-->
