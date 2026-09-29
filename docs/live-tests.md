# Live test: managed TensorRT-LLM install on Linux

`test/live/managed-install.test.ts` (task 2.18 of change `add-tensorrt-llm-linux`) installs the managed
TensorRT-LLM engine on a real Linux VM through the compiled core. It runs the whole path: probe, plan,
consent, the privileged step (`sudo <core> host-step exec <request>`), the relogin, the GPU check, the
engine image pull, `ready`, a curated model loaded through the `tensorrt-llm` provider, and one streamed
chat on `:1337`. Its output per distribution is the acceptance evidence for the PR.

It changes the machine: it installs Docker, the NVIDIA Container Toolkit and repositories with apt or
dnf, adds you to the `docker` group, may restart Docker, and pulls about 20 GiB of images. Run it only on
a throwaway VM, and take a snapshot first.

## What a run does

The test reads the machine before the core touches it and runs the scenarios that starting state can
exercise. The others are skipped, and each skip gives its reason.

| Scenario | Runs when the VM starts as |
| --- | --- |
| `preconditions` | always; fails with every problem listed (root user, no passwordless sudo to root or to yourself, no GPU, old driver, no binary, unsupported distribution) |
| `probe-plan` | always; the plan fits the machine, and probing changes nothing (packages, `daemon.json` and Docker's PID are compared) |
| `install-from-clean` | recipe distribution, no Docker |
| `toolkit-only-plan` | Fedora with `moby-engine` (or Debian/Ubuntu with `docker.io`), no toolkit |
| `restart-with-consent` | Docker running without the NVIDIA runtime. The test starts 2 `busybox` sentinel containers first |
| `consent-gates-work` | any setup: for 15 s at `awaiting-consent`, nothing is elevated, pulled or restarted |
| `privileged-step` | install or complete path: request file `0600` in a `0700` folder, `sudo -n <core> host-step exec`, receipt |
| `relogin` | the step added you to `docker` and this session predates it (see below) |
| `gpu-pull-ready` | any setup: `preparing-environment` → `pulling-image` (byte progress) → `verifying` → `activating` → `ready` |
| `adopt-ready-host` | Docker already reachable by you, with the NVIDIA runtime |
| `arch-blocked` | Arch without Docker or the toolkit: `prerequisite-blocked` with `pacman -Syu` commands |
| `arch-adopt` | Arch with the packages installed by hand and configured |
| `post-ready-probe-noop` | after `ready`: the plan adopts and lists no changes |
| `recipe-rerun-noop` | after a privileged step: the same request run again reports every step `satisfied`, and packages, `daemon.json` and Docker's PID stay the same |
| `model-chat` | after `ready`: smallest curated model for the GPU tier (inventory digest verified), `POST /models/tensorrt-llm/check` when the build has it, load, streamed chat on `:1337` |
| `selinux-no-permission-denied` | host SELinux enforcing (Fedora), with a model loaded. The snapshot's `selinux` must equal the **daemon's** (`docker info` `SecurityOptions` has `name=selinux`). Only when the daemon labels containers must bind mounts carry `z`. Always required: no `Permission denied` on a mounted path in `docker logs` or the core's log tail, and no `container_t` AVC denial since the load |

**How the relogin is tested.** A test cannot log out, so it emulates the new session. The first core
runs in the test's own session. That session predates the `docker` group, so the core must stop at
`relogin-required`. It must stay there after an explicit resume too, which re-checks the daemon. The
test then stops that core and starts a second one with `sudo -n -u $USER`. sudo builds the process's
groups with `initgroups(3)`, the same call `login`, `sshd` and the display manager make when a session
begins. The test reads `/proc/<pid>/status` to check that the new core has the `docker` gid. That core
must continue the operation on its own at startup, and the test never sends it a resume. `sg docker -c`
was not used, because it runs a shell string and sets only the primary group. `newgrp` was not used,
because it needs an interactive shell.

## VM requirements

- **Distributions** (the descriptor's `linux.install-container-runtime` list): Ubuntu 22.04, 24.04 and 26.04
  LTS; Debian 12 and 13; Fedora 43 and 44 (Workstation or Server) with SELinux **enforcing** (the default;
  `getenforce` must print `Enforcing`). All are x86_64, plus aarch64 where hardware exists (GH200,
  GB10/DGX Spark, Ampere Altra with an NVIDIA card). Arch is optional: it covers `arch-blocked` and
  `arch-adopt`.
- **GPU**: an NVIDIA card with compute capability 8.0 or newer (Ampere or later), **12 GB or more
  recommended**. The smallest curated model, `Qwen/Qwen3-1.7B` in BF16, has 4.1 GB of weights and is
  listed for 8 GB cards. However, the core's pre-launch check compares weights plus a KV-cache reserve
  for the context length against the card's *free* memory, and on an 8 GB card with a desktop or another
  process on it, that check can refuse the load. On 8 GB, set `ATOMIC_LIVE_TRT_CONTEXT_LENGTH=4096` (or
  lower), which the test passes as the load's `overrides.context_length`.
- **Virtualization**: on a KVM/Proxmox host, pass the card through with VFIO (the whole IOMMU group,
  `rombar` as your platform needs, `x-vga` off), and set the **vCPU type to `host`**. The Bun-compiled
  `bun-linux-x64` binary needs AVX2, and Proxmox's default `x86-64-v2-AES` lacks it, so the core would
  die with `SIGILL`. A cloud GPU instance (for example AWS g5/g6 or GCP g2) with a stock image also
  works. Inside the VM, `lspci | grep -i nvidia` must list the card, and `grep -m1 -o avx2 /proc/cpuinfo`
  must print `avx2`.
- **Driver**: NVIDIA driver **590.44.01 or newer** (`minimum_driver_version` in
  `atomic-chat-conf/runtimes/tensorrt-llm.json`). Install it the distribution's usual way. The test and
  the recipe never install drivers. Examples: Ubuntu `sudo ubuntu-drivers install`, or `nvidia-driver-590`;
  Debian, NVIDIA's CUDA repository; Fedora, RPM Fusion `akmod-nvidia`, with SELinux left enforcing. Check
  with `nvidia-smi --query-gpu=name,compute_cap,driver_version --format=csv`.
- **User**: a normal user, not root, with passwordless sudo for any target user:
  `<user> ALL=(ALL) NOPASSWD: ALL` (for example in `/etc/sudoers.d/90-live`). sudoers must not set
  `Defaults preserve_groups`, because the relogin emulation depends on sudo resetting the groups. A rule
  for root only, such as `(root) NOPASSWD: ALL`, is not enough: `preconditions` also checks
  `sudo -n -u $USER true`, which the relogin core needs. The
  repository checkout must be on a local disk that root can read (not NFS with `root_squash`).
- **Disk**: at least 100 GB free under `/var/lib/docker` (the descriptor's `required_disk_bytes` is 63 GiB),
  plus 5 GB in `$HOME` for the model cache.
- **Network**: `download.docker.com`, `nvidia.github.io`, `nvcr.io`, `huggingface.co`, and Docker Hub
  (for the `busybox` sentinels).
- **Node.js 22+** (vitest runs on it) and **Bun** (the repository's lockfile is `bun.lock`, and there is
  no `package-lock.json`, so `npm ci` cannot work): `curl -fsSL https://bun.sh/install | bash`, then open
  a new shell.
- **Ubuntu/Debian: no background upgrades during the run.** `unattended-upgrades` can hold the dpkg lock
  past the recipe's timeout, or change the installed-package set that `probe-plan` and
  `recipe-rerun-noop` compare. Before the run, wait for it to finish and stop it:
  `sudo systemctl stop unattended-upgrades apt-daily.timer apt-daily-upgrade.timer`, and check that
  `pgrep -a 'apt|dpkg'` prints nothing. Fedora: `sudo systemctl stop dnf-makecache.timer`, and keep
  GNOME Software from updating in the background.

### Starting states to prepare

Snapshot each state so you can run it again.

| State | How to prepare it | Covers |
| --- | --- | --- |
| **A. Clean** (every distribution) | fresh install + NVIDIA driver, nothing else | `install-from-clean`, `privileged-step`, `relogin`, `gpu-pull-ready`, `recipe-rerun-noop`, `model-chat`. On Fedora also `selinux-no-permission-denied` with a daemon that does **not** label containers: Docker CE's `dockerd` runs without `--selinux-enabled`, so the core must report `selinux: false` and mount without `:z` |
| **A′. Ready** | state A after a passing run, then **log out and back in** | `adopt-ready-host` |
| **B. Docker with containers** (one apt and one dnf distribution) | Docker CE from Docker's repository (`docker-ce`), `sudo usermod -aG docker $USER`, log in again, no toolkit | `restart-with-consent` (exact container count), `privileged-step` without relogin |
| **C. Fedora moby-engine** (Fedora 43 and 44) | `sudo dnf install moby-engine && sudo systemctl enable --now docker`, no toolkit | `toolkit-only-plan`, and `restart-with-consent` (the count shows as `unknown` unless you are also in `docker`). This is **the run that covers `:z`**: Fedora's `moby-engine` runs with `--selinux-enabled`, so `selinux-no-permission-denied` requires `selinux: true` and `z` on every bind mount |
| **D. Arch, missing** | Arch + NVIDIA driver, no Docker | `arch-blocked` |
| **D′. Arch, by hand** | `sudo pacman -Syu --needed docker nvidia-container-toolkit`, `sudo nvidia-ctk runtime configure --runtime=docker`, `sudo systemctl enable --now docker`, `sudo usermod -aG docker $USER`, reboot or log in again | `arch-adopt`, `gpu-pull-ready`, `model-chat` |

## Build and copy

On the development machine (macOS or Linux, Bun on PATH), at the commit under test:

```sh
cd atomic-chat-core
bun install --frozen-lockfile
npm run build:bin:all          # 12 binaries: the CLI and app cores for six targets, into dist/bin/
ls dist/bin/atomic-chat-core-*-unknown-linux-gnu
```

Only the CLI core for the VM's architecture is needed. These are the flags `scripts/build-binaries.mjs`
uses. For x86_64:

```sh
bun build --compile --target=bun-linux-x64 --minify-syntax --minify-whitespace --sourcemap \
  src/cli/bin.ts --outfile dist/bin/atomic-chat-core-x86_64-unknown-linux-gnu
```

For aarch64:

```sh
bun build --compile --target=bun-linux-arm64 --minify-syntax --minify-whitespace --sourcemap \
  src/cli/bin.ts --outfile dist/bin/atomic-chat-core-aarch64-unknown-linux-gnu
```

Copy the checkout without `node_modules`, the binary, and the conf descriptor to the VM:

```sh
rsync -a --exclude node_modules --exclude test/tmp ./ vm:atomic-chat-core/
scp ../atomic-chat-conf/runtimes/tensorrt-llm.json vm:tensorrt-llm.json
ssh vm 'cd atomic-chat-core && ~/.bun/bin/bun install --frozen-lockfile'
```

On the VM, `dist/bin/atomic-chat-core-$(uname -m)-unknown-linux-gnu` must exist and be executable. If it
lives elsewhere, point `ATOMIC_LIVE_CORE_BIN` at it.

## Run

Open a **fresh ssh login** to the VM as the normal user. Do not use `sudo -i` or `su`. Start `tmux`
**inside that login**, so an ssh drop in the middle of `apt` or the pull does not kill the run. A tmux
started now still predates the `docker` group, so the relogin emulation is unaffected. Do not attach to
a tmux server started earlier by another login. Then run:

```sh
tmux new -s live
cd ~/atomic-chat-core
. /etc/os-release
ATOMIC_LIVE=1 ATOMIC_LIVE_MANAGED=1 \
ATOMIC_RUNTIME_DESCRIPTOR_URL="file://$HOME/tensorrt-llm.json" \
npx vitest run --project live test/live/managed-install.test.ts 2>&1 \
  | tee "managed-install-$ID-$VERSION_ID-$(uname -m).log"
```

Both opt-ins are required: `ATOMIC_LIVE=1` alone (which `npm run test:live` sets) never starts this test,
because it installs system packages. Without `ATOMIC_RUNTIME_DESCRIPTOR_URL` the test uses the verbatim
copy in `test/fixtures/runtimes/tensorrt-llm.json`. Set it explicitly whenever conf has changed since that
copy.

Optional variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `ATOMIC_LIVE_CORE_BIN` | `dist/bin/atomic-chat-core-<arch>-unknown-linux-gnu` | the core binary under test |
| `ATOMIC_LIVE_OUT` | `test/tmp/live-managed-install/<id>-<version>-<arch>-<time>/` | output folder |
| `ATOMIC_LIVE_MODEL_CACHE` | `~/.cache/atomic-chat-live/hf` | downloaded checkpoints, kept across runs |
| `ATOMIC_LIVE_TRT_MODEL` | smallest curated model the card holds | a curated `repository` to load instead (anything not in `curated_models` fails with that message) |
| `ATOMIC_LIVE_TRT_CONTEXT_LENGTH` | unset (the provider's 8192) | the load's `context_length` override, for 8 GB cards; `max_output_tokens` becomes half of it, at most 4096 |
| `ATOMIC_LIVE_PUBLIC_PORT` | `1337` | public server port |
| `ATOMIC_LIVE_SENTINELS` / `ATOMIC_LIVE_SENTINEL_IMAGE` | `2` / `busybox:1.36` | containers a Docker restart must stop |
| `HF_ENDPOINT`, `HF_TOKEN` | huggingface.co, none | a mirror; curated models are ungated |

Expect about 30–90 minutes on a clean VM. Most of it is the ~20 GiB engine image pull and the first
model load.

The model comes from the documented Hugging Face flow, because the core never downloads models (design
D12). The test lists the curated revision (`/api/models/<repo>/revision/<rev>?blobs=true&files_metadata=true`),
refuses it unless the listing's `inventory_digest` matches the descriptor's, downloads every file, checks
each size and LFS sha256 (each request and file up to 6 tries, honouring `Retry-After` on 429/503, and a
broken transfer resumes its `.part` with a `Range` request), hard-links the files into `<data>/tensorrt-llm/models/<id>/`, and writes
`model.yml` (`repository`, `revision`, `architectures`, `quantization`, `files`) last.

Both cores run with `DO_NOT_TRACK=1`, so a test run sends no error reports, and with the login's
`XDG_RUNTIME_DIR`. The relogin core goes through sudo's `env_reset`, so everything it needs is passed
explicitly, the same for both.

The run leaves Docker, the toolkit, the group and the engine image installed. It unloads the model,
stops the core and removes the sentinel containers. To reset, go back to the snapshot.

## What to attach to the PR

For every run, one per distribution and starting state, attach from the output folder the test prints
(`output folder …` on its first log line):

- `summary.json`: host facts (distribution, version, arch, kernel, GPUs, driver, SELinux, Docker state
  before the run), core binary sha256 and git HEAD, descriptor id, every scenario's status, reason,
  duration and details, the operation's phases with timings, and the model's download, load and
  first-token times;
- `run.log` and `core.log`;
- `host-steps/*.request.json` and `*.result.json` (what ran as root, step by step);
- the `tee`'d console log.

Do not attach `data/`, which holds the model's hard links.

Put a table in the PR description: one row per distribution, version, arch and starting state, with its
passed, failed and skipped counts. A distribution or version whose run fails must not stay in
`recipes[].distributions` of `atomic-chat-conf/runtimes/tensorrt-llm.json` (conf task 1.2).
