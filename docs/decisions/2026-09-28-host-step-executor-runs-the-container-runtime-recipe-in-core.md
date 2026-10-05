---
date: 2026-09-28
title: "The host-step executor runs the container-runtime recipe in core, as pinned data"
---

# 2026-09-28 — The host-step executor runs the container-runtime recipe in core, as pinned data

- **Context:** Task 2.5 of `add-tensorrt-llm-linux` (design D2/D3/D5). Docker Engine and the NVIDIA
  Container Toolkit are installed by one privileged step that the app runs under `pkexec` and `atc`
  runs under `sudo`. Both must run the same code as root, speak the file protocol `atc host-step exec`
  already uses (request file in, result file out), refuse anything the user did not approve, and never
  remove or upgrade anything.
- **Decision:**
  1. The recipe lives in `src/host/recipes/` as one frozen data object (`INSTALL_CONTAINER_RUNTIME_RECIPE`:
     every argv template, path, URL, key fingerprint and file body) plus pure step builders.
     `recipe_digest` is the canonical-JSON sha256 of that object, pinned by a test; `parameters_digest`
     is the canonical-JSON sha256 of the normalised parameters (user, arch, family, distro id/version,
     components). The executor (`executeHostStep`, exported from `@atomic-chat/core/host`, run by
     `atomic-chat-core host-step exec`) recomputes both and refuses any mismatch, unknown recipe or
     invalid parameter before running anything.
  2. The request file gains a `parameters` object (additive to the CLI's `HostStepRequestFile`): a
     digest can only be checked against the values it hashes. The result file keeps the CLI's fields
     (`outcome`, `exit_code`, `log_tail`, ...) and adds the nonce, both digests, `error_code` and one
     outcome per step.
  3. Every command passes an allowlist (`assertPermittedCommand`) at run time; a test builds every
     component combination on every supported release and scans for removal/upgrade words. Package
     installs name only packages the machine is missing; Docker's packages are refused (not installed
     over, nothing removed) when `docker.io`/`containerd`/`runc`/`podman-docker` or `moby-engine`/`docker`
     is installed.
  4. Vendor keys are fetched with `fetch` (https, non-empty, ASCII-armored, CRC-checked) and every
     primary key in the file must match a pinned v4 fingerprint; dearmoring for apt's `.gpg` keyring is
     done in-process (no `gpg`, which minimal Debian lacks). On Fedora the recipe writes the `.repo`
     files itself with `gpgkey=file://` pointing at the pinned key, instead of `dnf config-manager`
     (which differs between dnf4 and dnf5 and would let `dnf -y` import an unchecked key).
  5. An existing key or repository file is kept, never overwritten. `apt-get update` is restricted to
     the one source list the recipe added.
  6. Docker is restarted only when the running daemon has not loaded the NVIDIA runtime (daemon.json
     changed, or it was registered earlier and never loaded), and only when the plan listed the restart
     (D5) or Docker was not running before the step began — the latter covers apt's `docker-ce`
     postinst starting a fresh daemon, which has no containers of the user's to stop.
  7. `usermod -aG docker` never runs for root, for any name that resolves to uid 0, or — when
     `PKEXEC_UID`/`SUDO_UID` says who asked — for anyone but that user.
- **Consequences:** a change to any command, URL, path, pin or file body changes `recipe_digest`, so
  clients holding an older plan are refused and must re-probe. Task 2.6 must put `parameters` in the
  request (today `ManagedHostStep` does not carry them) and use `parametersFromPlan` /
  `installContainerRuntimeParametersDigest`; the app (3.5) and `atc` must copy `parameters` into the
  request file. Docker's deb key and NVIDIA's key are pinned from the keys the vendors' URLs served on
  2026-09-28 (the current guides print no fingerprint); Docker's rpm key matches Docker's Fedora guide.
  A vendor key rotation fails the key step until the pin is updated.
- **Owner:** `team`.
- **Links:** `src/host/recipes/`, `src/cli/commands/host-step.ts`, `test/fixtures/host-keys/`;
  atomic-chat-cli `src/host/{helper,elevator,host-step}.ts`; openspec change `add-tensorrt-llm-linux`
  design D2/D3/D5, spec `managed-runtime-environment`.
