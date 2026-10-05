---
date: 2026-09-29
title: "The host step reads docker.service's journal when Docker does not start"
---

# 2026-09-29 — The host step reads docker.service's journal when Docker does not start

- **Context:** On the first real live run, Docker would not start on a host with a full-tunnel VPN
  (routes `0.0.0.0/1` and `128.0.0.0/1`): dockerd's own reason was "all predefined address pools
  have been fully subnetted". The host-step result carried only `systemctl`'s stderr ("See
  `journalctl -xeu docker.service` for details"), so the app — and the person — saw that Docker
  failed but not why, and the reason had to be dug out by hand on the machine.
- **Decision:** When `systemctl enable --now docker` (step `docker-service`) or the approved
  `systemctl restart docker` (step `nvidia-runtime`) exits non-zero, the executor runs the recipe's
  fixed argv `journalctl -u docker.service -n 40 --no-pager -o cat` and appends its output to that
  step's stderr, under a `journalctl -u docker.service:` line. The argv is part of the recipe data
  (so it is in the recipe digest the user consents to) and the allowlist admits `journalctl` in
  exactly that shape and no other. It runs on a diagnostic deadline of its own (30 s, 64 KiB of
  output) instead of the 10-minute command deadline. If it cannot run, fails or prints nothing, the
  step's stderr is exactly `systemctl`'s; the step's outcome, exit code and detail never change.
  The combined text goes through the existing 2000-character tail, which keeps its end — the
  journal's last lines, where dockerd's fatal error is.
- **Consequences:** The recipe digest changes (`sha256:852ceac8…`), so a request built by an older
  core against the old digest is refused — the intended effect of pinning. The journal lines are
  root-readable text from the host and reach the result file, which is written into the invoking
  user's folder (mode `0644`) and shown to that user; docker.service's messages carry nothing that
  user could not already read with `journalctl` as a member of `adm`/`systemd-journal` on common
  distributions, and are bounded to 40 lines. The workaround for the VPN case itself is a
  documented host precondition (`docs/live-tests.md`), not a recipe change.
- **Owner:** `team`.
- **Links:** `src/host/recipes/install-container-runtime.ts` (`DOCKER_JOURNAL`, `PERMITTED`,
  `assertPermittedCommand`), `src/host/recipes/executor.ts` (`mustStartDocker`),
  `src/host/recipes/executor-io.ts` (`DIAGNOSTIC_TIMEOUT_MS`); record
  `2026-09-28-host-step-executor-runs-the-container-runtime-recipe-in-core.md`.
