---
date: 2026-10-01
title: "TensorRT-LLM on Windows runs in Atomic Chat's own WSL distribution, switched on by conf"
---

# 2026-10-01 — TensorRT-LLM on Windows runs in Atomic Chat's own WSL distribution, switched on by conf

- **Context:** TensorRT-LLM ran only on Linux (change `add-tensorrt-llm-linux`): NVIDIA ships it as a
  Linux container and nothing else. Many owners of NVIDIA cards are on Windows. The environment
  contract was already split per platform (`runtimes/environments/<platform>.json`, ADR
  2026-10-01-read-install-distributions-from-the-environment-manifest), the executor kinds already
  named `wsl-docker`, the host actions `windows.enable-wsl`, the state machine `reboot-required`; a
  ported `windows-probe.ts` existed but was never registered. Live acceptance on a Windows machine is
  not part of this change (openspec change `add-tensorrt-llm-windows`, "Технический долг").
- **Decision:** the engine runs in a WSL2 distribution Atomic Chat imports and owns, one per Windows
  user and shared by every managed engine, driven by the same code as a Linux host (design D1–D16):
  1. **The guest is a Linux host behind a transport (D1).** `src/runtime/wsl/transport.ts` runs argv
     through `wsl.exe -d <name> [-u <user>] --exec`, never a shell, decodes `wsl.exe`'s UTF-16, bounds
     time and output, takes an injected executable (`%SystemRoot%\System32\wsl.exe`, never `PATH`).
     `probeLinux`/`assessLinux` judge the guest (`guest-host.ts`); the Linux install recipe prepares it
     through the same `executeHostStep` (`host/recipes/guest-executor.ts`); every docker call is the
     guest's `/usr/bin/docker` as root (`container/wsl-exec.ts`).
  2. **One elevated step (D2).** `windows.enable-wsl` runs only `wsl --install --no-distribution`
     (no parameters), then `wsl --status`; its result file says `completed`, `reboot-required` or
     `failed`. The executor trusts the request folder by its owner and ACL, read by SID
     (`executor-io-windows.ts`). Import and everything else run unelevated: an elevated `wsl.exe` sees
     another user's or another namespace's distributions (microsoft/WSL#9690); a core started elevated
     is blocked (`elevated-process`).
  3. **Root in the guest, no `docker` group (D3); Engine API inside the guest (D4).** Pulls stream
     NDJSON from `curl --unix-socket` in the guest (`pullImageWithCurl`); the socket never leaves it.
  4. **Everything a container sees is in ext4 (D5).** `/var/lib/atomic-chat/scopes/<scope_key>/` holds
     models, engine caches, heartbeats and the watchdog; `scope_key` lives in the scope's data
     (`guest-scope.json`), so moving the data folder keeps the models. Core reaches them as
     `\\wsl.localhost\<name>\…` (`GuestMount`), the guest's Docker mounts the guest path
     (`wslMountSourceResolver`), `realpath` runs in the guest, the container runs as uid 1000, and
     sizes and removals are `du`/`rm` in the guest.
  5. **Core names the models root on every platform (D6):** `GET /atomic/v1/models/tensorrt-llm/location`.
  6. **Forwarding is checked (D7).** The port is `127.0.0.1::<port>` in the guest, read back with
     `docker port`; install (`verifying`) and every load check "answers in the guest, not on Windows",
     which fails with `wsl-localhost-forwarding` and an instruction from the read-only `.wslconfig`; a
     Windows program holding the port gets one new publication.
  7. **The distribution is held while needed (D8)** by an attached `wsl.exe … sleep infinity` per
     lease (`DistributionKeeper`); a VM stopped under a session ends it with `session:died`
     `reason: 'wsl-stopped'`, without a docker call that would start the VM again.
  8. **The import (D9):** the manifest's rootfs, sha256-checked before use, `wsl --import` (fallback
     `--install --from-file`) into `%LOCALAPPDATA%\AtomicChat\wsl\AtomicChat`, the user's default
     distribution put back, a uid-1000 user, `/etc/wsl.conf` (systemd on, no Windows `PATH`) and an
     ownership marker; the environment record (`environment.json`) pins its `manifest_id`.
  9. **Driver and memory from the guest (D10, D11):** the descriptor's `minimum_driver_version` is
     compared with the NVML library version in the guest (`nvidia-smi --version`), not the Windows
     driver's number; the model check compares the VM's memory and warns (`wsl-vm-memory`), never refuses.
  10. **Removing the environment (D12)** is `wsl --unregister` of ours only, refused while an engine is
     installed, with a plan that lists the models and the space.
  11. **The switch (D14).** The Windows code ships in core and app, but without
     `runtimes/environments/windows.json` in conf main a Windows core with no distribution answers
     `unsupported` (`MANAGED_METADATA_INVALID`), and the provider stays hidden. Merging `windows-r1`
     into conf main — only after the live acceptance — turns it on, with no release.
- **Consequences:** Windows behaviour is covered by unit tests and by the compiled core's e2e
  (`test/e2e/managed-windows.test.ts`) through `ATOMIC_MANAGED_TEST_WINDOWS` and a fake `wsl.exe` (a
  Node script, so it runs on `windows-2022` and every other runner); real WSL, GPU passthrough, the
  `.wsl` import format, forwarding in `mirrored` mode, the VM's memory under a large model and the
  write speed through `\\wsl.localhost` are proved only by the live acceptance (`docs/live-tests.md`,
  "Windows acceptance"). Linux behaviour is unchanged: its tests pass with their expectations as they
  were. New wire fields are additive: `EnvironmentSnapshot.distribution`, `ManagedHostStep.parameters`
  as a union by `action`, `EnvironmentManifest` as a union by `platform`, `ModelCompatibility.warnings`,
  `session:died.reason`, `HostStepResult.outcome: 'reboot-required'`. The Windows rulings are in
  `atomic-chat-spec/openspec/changes/add-tensorrt-llm-windows/rulings/core.md`.
- **Owner:** `team`.
- **Links:** openspec change `add-tensorrt-llm-windows` (design D1–D16, spec `wsl-runtime-environment`);
  `src/runtime/wsl/`, `src/runtime/environment/windows-*.ts`, `guest-host.ts`,
  `src/host/recipes/{enable-wsl,executor-io-windows,guest-executor}.ts`,
  `src/runtime/managed-text/wsl-deployment.ts`, `src/runtime/tensorrt-llm/{location,guest-files}.ts`,
  `src/core/{managed-environment,tensorrt-llm}.ts`.
