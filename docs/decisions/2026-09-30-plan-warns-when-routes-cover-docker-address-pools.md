---
date: 2026-09-30
title: "The plan warns when the host's routes cover Docker's default address pools; a failed start names the cause"
---

# 2026-09-30 — The plan warns when the host's routes cover Docker's default address pools; a failed start names the cause

- **Context:** on the 3.10 host (finding F-4) a full-tunnel VPN routed `0.0.0.0/1` and `128.0.0.0/1`.
  After `systemctl enable --now docker`, dockerd exited with "all predefined address pools have been
  fully subnetted", and the step failed after consent. The user saw only "Preparing the system did not
  finish"; the cause was in the journal tail of the step's result file, which the core never receives.
- **Decision:** (owner ruling R-core-9.) The probe reads `/proc/net/route` and `/etc/docker/daemon.json`,
  both read-only. When Docker is not running (daemon unreachable and `docker.service` not active),
  every default Docker subnet overlaps some non-default route, and `daemon.json` sets neither `bip` nor
  `default-address-pools`, `assessLinux` adds a warning, not a blocker:
  `docker-address-pools-overlap-routes`, with `params.routes` naming the routes over the pools and a
  text telling the user to exclude those ranges from the VPN or to set `default-address-pools`/`bip`.
  The default subnets are moby `libnetwork/ipamutils` `localScopeDefaultNetworks`: 172.17–172.31 as
  /16s and 192.168.0.0/16 as /20s, 31 in all. An unread table or `daemon.json` suppresses the warning.
  `RequirementPlan` gains the additive `warnings: ManagedPlanWarning[]` (`{code, text, params?}`, empty
  when none); control protocol 2 is unchanged. Warnings are **not** in `plan_digest`. The digest input
  does not cover routes, and a VPN switched on or off would otherwise ask for a new consent to a plan
  that changes nothing on the machine. `ManagedHostReceipt` gains an optional `log_tail` (the result
  file's own, the last 16 KiB kept). On a `failed` receipt that tail becomes the error's `details`, and
  when it contains Docker's pool message, the error's `message` names the cause with the same
  instruction. The match is on the phrase, so the approved restart after the runtime configuration is
  covered as well as `docker-service`. The recipe never edits Docker's network configuration, and no
  root code changed for this.
- **Consequences:** the user learns about the VPN before consenting and, if they go ahead anyway,
  why the step failed. Routes are read from `/proc/net/route` rather than `ip -4 route`: the file is
  always there, Docker checks the same main table, and it needs no binary on `PATH`. Decoding assumes a
  little-endian host, which both supported architectures are. Policy-routed VPNs (WireGuard's own
  table) are not in the main table, and Docker does not see them either. The failure text depends on
  the app forwarding `log_tail` (app finding F-2, an app task). Without it, the error is the old one,
  with the receipt id in `details`.
- **Owner:** `team`
- **Links:** task 2.23 (F-4), `manual-test-3.10.md`, `rulings/core.md` R-core-9;
  `src/runtime/environment/linux-docker-network.ts`, `host-step-failure.ts`, `linux-plan.ts`,
  `linux-provisioner.ts`, `state.ts`; `src/server/control/routes/environments.ts`;
  `src/contracts/environment.ts`.
