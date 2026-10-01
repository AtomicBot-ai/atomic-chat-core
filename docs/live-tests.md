# Live tests: managed TensorRT-LLM on Linux

Two live tests cover the managed TensorRT-LLM engine on real Linux machines with NVIDIA cards:

- [Install test](#install-test-task-218), `test/live/managed-install.test.ts` (task 2.18): installs Docker,
  the NVIDIA Container Toolkit and the engine through the core's own setup, on a throwaway VM.
- [Engine test](#engine-test-task-219), `test/live/tensorrt-llm.test.ts` (task 2.19): runs the installed
  engine on every NVIDIA card of a host and measures the values the design left open. It changes nothing
  on the host.

**Thinking is off in every chat request.** Where a scenario wants a plain answer (the install test's
`model-chat`; the engine test's `stream`, `tool-call`, `structured-output` and
`structured-output-refused`), the request carries `chat_template_kwargs: {"enable_thinking": false}`
(`THINKING_OFF` in `test/helpers/live-core.ts`). Qwen3's `/no_think` soft switch is not used: TRT-LLM
1.2.1's `qwen3` reasoning parser ends reasoning only at `</think>`, and with `/no_think` Qwen3-1.7B opens
`<think>` and never closes it, so the whole answer, a tool call included, lands in `reasoning_content`
(4 of 4 on the first live run). `enable_thinking: false` closes the think block in the prompt itself, and
the tool parser returned the call 3 of 3 times. The report still records `reasoning_content` and
`finish_reason`.

## Install test (task 2.18)

`test/live/managed-install.test.ts` (task 2.18 of change `add-tensorrt-llm-linux`) installs the managed
TensorRT-LLM engine on a real Linux VM through the compiled core. It runs the whole path: probe, plan,
consent, the privileged step (`sudo <core> host-step exec <request>`), the relogin, the GPU check, the
engine image pull, `ready`, a curated model loaded through the `tensorrt-llm` provider, and one streamed
chat on `:1337`. Its output per distribution is the acceptance evidence for the PR.

It changes the machine: it installs Docker, the NVIDIA Container Toolkit and repositories with apt or
dnf, adds you to the `docker` group, may restart Docker, and pulls about 20 GiB of images. Run it only on
a throwaway VM, and take a snapshot first.

### What a run does

The test reads the machine before the core touches it and runs the scenarios that starting state can
exercise. The others are skipped, and each skip gives its reason.

| Scenario | Runs when the VM starts as |
| --- | --- |
| `preconditions` | always; fails with every problem listed (root user, no passwordless sudo to root or to yourself, no GPU, old driver, no binary, unsupported distribution) |
| `probe-plan` | always; the plan fits the machine, and probing changes nothing (packages, `daemon.json` and Docker's PID are compared) |
| `install-from-clean` | recipe distribution, no Docker |
| `toolkit-only-plan` | Fedora with `moby-engine` (or Debian/Ubuntu with `docker.io`), no toolkit |
| `toolkit-base-plan` | Docker installed and running, with only `nvidia-container-toolkit-base` (state B′): the plan installs `nvidia-container-toolkit` and generates the CDI spec (`generate-cdi-spec`); no runtime configure or restart when the daemon already loaded the `nvidia` runtime. `gpu-pull-ready` then shows the GPU check passing |
| `address-pool-warning` | the host's routes (`/proc/net/route`) cover every default Docker address pool, Docker is not running, and `/etc/docker/daemon.json` sets neither `bip` nor `default-address-pools`: the plan carries the `docker-address-pools-overlap-routes` warning, no blocker, and its `params.routes` must equal the routes causing it as the test itself works them out from `/proc/net/route` (the fewest that cover every pool, e.g. only `128.0.0.0/1` for a full tunnel). Skipped with the reason otherwise |
| `restart-with-consent` | Docker running without the NVIDIA runtime. The test starts 2 `busybox` sentinel containers first |
| `consent-gates-work` | any setup: for 15 s at `awaiting-consent`, nothing is elevated, pulled or restarted |
| `privileged-step` | install or complete path: request file `0600` in a `0700` folder, `sudo -n <core> host-step exec`, receipt |
| `relogin` | the step added you to `docker` and the first core's process does not hold the `docker` gid (see below) |
| `gpu-pull-ready` | any setup: `preparing-environment` → `pulling-image` (byte progress) → `verifying` → `activating` → `ready` |
| `adopt-ready-host` | Docker already reachable by you, with an NVIDIA CDI device listed (`nvidia-ctk cdi list` shows `nvidia.com/gpu`); a registered `nvidia` runtime without the spec is not ready (task 2.23) |
| `arch-blocked` | Arch without Docker or the toolkit: `prerequisite-blocked` with `pacman -Syu` commands |
| `arch-adopt` | Arch with the packages installed by hand and configured |
| `post-ready-probe-noop` | after `ready`: the plan adopts and lists no changes |
| `recipe-rerun-noop` | after a privileged step: the same request run again reports every step `satisfied`, and packages, `daemon.json` and Docker's PID stay the same |
| `model-chat` | after `ready`: smallest curated model for the GPU tier (inventory digest verified), `POST /models/tensorrt-llm/check` when the build has it, load, streamed chat on `:1337` |
| `selinux-no-permission-denied` | host SELinux enforcing (Fedora), with a model loaded. The snapshot's `selinux` must equal the **daemon's** (`docker info` `SecurityOptions` has `name=selinux`). Only when the daemon labels containers must bind mounts carry `z`. Always required: no `Permission denied` on a mounted path in `docker logs` or the core's log tail, and no `container_t` AVC denial since the load |
| `remove-after-load` | after `model-chat`, unless `ATOMIC_LIVE_MANAGED_KEEP_ENGINE=1`: with the model still loaded, a `remove` operation (consented, `retain_models: true`) must end in `removed`, the model container must no longer run, and the engine cache folder, the installation record (`managed/installations/tensorrt-llm/installation.json` and the snapshot's installation) and the engine image (`docker images --digests`) must all be gone. A failure records the operation's error code |

**How the relogin is tested.** A test cannot log out, so it emulates the new session. The first core
runs in the test's own session. That session predates the `docker` group, so the core must stop at
`relogin-required`. It must stay there after an explicit resume too, which re-checks the daemon. The
test then stops that core and starts a second one with `sudo -n -u $USER`. sudo builds the process's
groups with `initgroups(3)`, the same call `login`, `sshd` and the display manager make when a session
begins. The test reads `/proc/<pid>/status` to check that the new core has the `docker` gid. That core
must continue the operation on its own at startup, and the test never sends it a resume. `sg docker -c`
was not used, because it runs a shell string and sets only the primary group. `newgrp` was not used,
because it needs an interactive shell.

Whether a relogin is expected at all is decided by number, not by name: the `docker` gid is read with
`getent group docker` after the privileged step, and compared with the `Groups:` line of the first
core's `/proc/<pid>/status`. A session can already hold a gid whose group was deleted (Docker purged by
hand) and then re-created with the same number by the step. `id -nG` taken before the step cannot name
that gid, but the core reaches the daemon with it and rightly goes on without a relogin.

### VM requirements

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
  - **nvcr.io from a restricted region** answers `403`, on `proxy_auth` too. The egress must stay
    outside such regions for the whole engine image pull, which takes a long time; a route that changes
    halfway fails the pull.
  - **A full-tunnel VPN** (routes `0.0.0.0/1` and `128.0.0.0/1`) leaves dockerd no private range it
    considers free, and Docker does not start: "all predefined address pools have been fully subnetted"
    in `journalctl -u docker.service`. The plan now warns about it before consent (task 2.23): a
    `docker-address-pools-overlap-routes` warning naming the routes, which `address-pool-warning` checks
    on a host in that state. The recipe never edits Docker's network configuration, so the workaround is
    still yours: before continuing (and before Docker is installed), exclude Docker's ranges from the VPN,
    or create `/etc/docker/daemon.json` with a bridge address in any unused `/24`, for example
    `{"bip": "172.30.99.1/24"}`
    (`sudo mkdir -p /etc/docker && echo '{"bip": "172.30.99.1/24"}' | sudo tee /etc/docker/daemon.json`).
    The recipe's `nvidia-ctk runtime configure` merges the NVIDIA runtime into that file and keeps the
    key. Verified on the real host: after the recipe, `/etc/docker/daemon.json` was
    `{"bip":"172.30.99.1/24","runtimes":{"nvidia":{...}}}`, so `nvidia-ctk` kept the pre-existing `bip`
    key. If the step fails on it anyway, the operation's error names this cause (when the app forwards
    the step's log tail with its receipt), and a retry after the fix starts Docker again: the recipe
    clears systemd's `start-limit-hit` with `systemctl reset-failed` first.
- **Node.js 22+** (vitest runs on it) and **Bun 1.3.10**, the version CI pins (the repository's lockfile
  is `bun.lock`, and there is no `package-lock.json`, so `npm ci` cannot work):
  `curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.10"`, then open a new shell.
- **Ubuntu/Debian: no background upgrades during the run.** `unattended-upgrades` can hold the dpkg lock
  past the recipe's timeout, or change the installed-package set that `probe-plan` and
  `recipe-rerun-noop` compare. Before the run, wait for it to finish and stop it:
  `sudo systemctl stop unattended-upgrades apt-daily.timer apt-daily-upgrade.timer`, and check that
  `pgrep -a 'apt|dpkg'` prints nothing. Fedora: `sudo systemctl stop dnf-makecache.timer`, and keep
  GNOME Software from updating in the background.

#### Starting states to prepare

Snapshot each state so you can run it again.

| State | How to prepare it | Covers |
| --- | --- | --- |
| **A. Clean** (every distribution) | fresh install + NVIDIA driver, nothing else | `install-from-clean`, `privileged-step`, `relogin`, `gpu-pull-ready`, `recipe-rerun-noop`, `model-chat`. On Fedora also `selinux-no-permission-denied` with a daemon that does **not** label containers: Docker CE's `dockerd` runs without `--selinux-enabled`, so the core must report `selinux: false` and mount without `:z` |
| **A′. Ready** | state A after a passing run, then **log out and back in** | `adopt-ready-host` |
| **B. Docker with containers** (one apt and one dnf distribution) | Docker CE from Docker's repository (`docker-ce`), `sudo usermod -aG docker $USER`, log in again, no toolkit | `restart-with-consent` (exact container count), `privileged-step` without relogin |
| **B′. Docker, toolkit `-base` only** (at least Ubuntu 26.04, the 3.10 acceptance host) | state B, then add NVIDIA's apt repository and `sudo apt-get install nvidia-container-toolkit-base` only (not `nvidia-container-toolkit`); optionally `sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker` to also have the `nvidia` runtime loaded, as on that host. Check that `nvidia-ctk cdi list` shows no `nvidia.com/gpu` | `toolkit-base-plan`, `privileged-step` (the full toolkit and `nvidia-cdi`), `gpu-pull-ready` (the GPU check passes through CDI), `recipe-rerun-noop` |
| **V. Full-tunnel VPN** (any state where Docker is not running, e.g. A) | connect a VPN that routes `0.0.0.0/1` and `128.0.0.0/1`, and leave `/etc/docker/daemon.json` without `bip`/`default-address-pools`; `ip -4 route` should list both | `address-pool-warning`. Consent and the step would then fail at `docker-service`; disconnect the VPN (or set `bip`) before consenting if you want the rest of the run |
| **C. Fedora moby-engine** (Fedora 43 and 44) | `sudo dnf install moby-engine && sudo systemctl enable --now docker`, no toolkit | `toolkit-only-plan`, and `restart-with-consent` (the count shows as `unknown` unless you are also in `docker`). This is **the run that covers `:z`**: Fedora's `moby-engine` runs with `--selinux-enabled`, so `selinux-no-permission-denied` requires `selinux: true` and `z` on every bind mount |
| **D. Arch, missing** | Arch + NVIDIA driver, no Docker | `arch-blocked` |
| **D′. Arch, by hand** | `sudo pacman -Syu --needed docker nvidia-container-toolkit`, `sudo nvidia-ctk runtime configure --runtime=docker`, `sudo nvidia-ctk cdi generate --output=/var/run/cdi/nvidia.yaml` (and `sudo systemctl enable --now nvidia-cdi-refresh.path` where the package ships it: `/var/run` does not survive a reboot), `sudo systemctl enable --now docker`, `sudo usermod -aG docker $USER`, reboot or log in again | `arch-adopt`, `gpu-pull-ready`, `model-chat` |

### Build and copy

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

Copy the checkout without `node_modules`, the binary, the conf descriptor and the conf environment
manifest to the VM:

```sh
rsync -a --exclude node_modules --exclude test/tmp ./ vm:atomic-chat-core/
scp ../atomic-chat-conf/runtimes/tensorrt-llm.json vm:tensorrt-llm.json
scp ../atomic-chat-conf/runtimes/environments/linux.json vm:linux.json
ssh vm 'cd atomic-chat-core && ~/.bun/bin/bun install --frozen-lockfile'
```

On the VM, `dist/bin/atomic-chat-core-$(uname -m)-unknown-linux-gnu` must exist and be executable. If it
lives elsewhere, point `ATOMIC_LIVE_CORE_BIN` at it.

### Run

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
ATOMIC_ENVIRONMENT_MANIFEST_URL="file://$HOME/linux.json" \
npx vitest run --project live test/live/managed-install.test.ts 2>&1 \
  | tee "managed-install-$ID-$VERSION_ID-$(uname -m).log"
```

Without tmux, a detached process survives an ssh drop too. Put the command above (without `tmux new`)
into a script, `chmod +x` it, and start it from the same fresh login with
`setsid nohup ./run-live.sh > run-live.log 2>&1 < /dev/null &`; follow it with `tail -f run-live.log`. It
keeps that login's groups, so the relogin emulation is unaffected as well.

Both opt-ins are required: `ATOMIC_LIVE=1` alone (which `npm run test:live` sets) never starts this test,
because it installs system packages. Without `ATOMIC_RUNTIME_DESCRIPTOR_URL` the test uses the verbatim
copy in `test/fixtures/runtimes/tensorrt-llm.json`, and without `ATOMIC_ENVIRONMENT_MANIFEST_URL` the
copy in `test/fixtures/runtimes/environments/linux.json`. Set both explicitly whenever conf has changed
since those copies. The two are separate documents: the descriptor says what the engine needs (image,
driver, compute capability), the manifest says on which distributions the core installs Docker and the
toolkit itself. The test passes both to the core it starts, and decides whether this host is a recipe
host from the manifest.

Optional variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `ATOMIC_LIVE_CORE_BIN` | `dist/bin/atomic-chat-core-<arch>-unknown-linux-gnu` | the core binary under test |
| `ATOMIC_LIVE_OUT` | `test/tmp/live-managed-install/<id>-<version>-<arch>-<time>/` | output folder |
| `ATOMIC_LIVE_MODEL_CACHE` | `~/.cache/atomic-chat-live/hf` | downloaded checkpoints, kept across runs |
| `ATOMIC_LIVE_TRT_MODEL` | smallest curated model the card holds | a curated `repository` to load instead (anything not in `curated_models` fails with that message) |
| `ATOMIC_LIVE_TRT_CONTEXT_LENGTH` | unset (the provider's 8192) | stored as the run's `context_length` setting before the model check, so `POST /models/tensorrt-llm/check` and the load both reserve KV cache for it (the check reads stored settings only); for 8 GB cards. `max_output_tokens` becomes half of it, at most 4096 |
| `ATOMIC_LIVE_MANAGED_KEEP_ENGINE` | unset | `1` skips `remove-after-load`, so the engine stays installed for the [engine test](#engine-test-task-219) |
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

The run leaves Docker, the toolkit and the group installed. Unless `ATOMIC_LIVE_MANAGED_KEEP_ENGINE=1`, its
last scenario removes the engine itself (image, engine caches, installation record) through the core. It
stops the core and removes the sentinel containers. To reset, go back to the snapshot. To run the engine
test next on the same VM, set `ATOMIC_LIVE_MANAGED_KEEP_ENGINE=1` here.

### What to attach to the PR

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
`recipes[].distributions` of `atomic-chat-conf/runtimes/environments/linux.json`: removing it, like
adding one, is a new `manifest_id`, and the engine descriptor does not change.

## Engine test (task 2.19)

`test/live/tensorrt-llm.test.ts` runs the installed engine through the compiled core on **every NVIDIA
card of the host**, one card after another. Each card is pinned the way the app pins it: through the
provider's stored `gpu_id` setting (`PATCH /atomic/v1/settings/tensorrt-llm`), in the run's own data
folder, never yours. The test also measures what the design left open: the heartbeat interval,
the watchdog limit, `--shm-size`, the container memory limit, and the load timeout coefficients. It
records the measurements and does not decide them. You carry them into an ADR (see below).

It changes nothing on the host. It never installs, removes or reconfigures packages, Docker or groups.
It downloads curated models into a cache in your home folder, loads and unloads them, reads Docker as
root through `sudo -n` (`inspect`, `ps`, `logs`, and one read-only `df` inside the engine container), and
sends `SIGKILL` only to the core process it started itself.

### What a run does

Each card gets eight named scenarios, `gpu<N>-<scenario>`, where `N` is the card's `nvidia-smi` index. A
card below the descriptor's minimum compute capability, or with no curated model that fits, has its
scenarios skipped with that reason. One scenario for the whole host, `reload-while-other-loads`, runs
after the cards.

| Scenario | What it checks |
| --- | --- |
| `preconditions` | Checked once. Fails with every problem listed: no binary, no GPU, a driver older than the descriptor's minimum, no passwordless sudo, or a session that cannot reach Docker. It then starts the core and reads `/snapshot`, and **fails unless the engine installation is `ready`** and pinned to the same descriptor the test reads. |
| `gpu<N>-load` | Loads the curated model of the card's memory tier, pinned to this card. The download goes through the documented flow (inventory digest, `POST /models/tensorrt-llm/check` with this card's `gpu_id`, sizes and sha256). The check: the container got exactly this card (`DeviceRequests`), the core substituted no other card, and `session:load-progress` reached `ready`. Records the load time, each stage's elapsed time, peak VRAM and peak `/dev/shm`. Every first load is cold: the engine cache is keyed by descriptor and model, not by card, so when an earlier card of the same tier already filled it, the test deletes that folder in the run's own data folder first and records `engine_cache_warm: true`. If this user cannot delete it (the engine wrote files as someone else), the scenario fails with that. Each model is downloaded, hashed and linked once per run; later cards only run the check for their own `gpu_id`. |
| `gpu<N>-container-user` | The running engine container's `Config.User` is the `uid:gid` of the user running the core, and every file and folder the load wrote under the model's engine cache is owned by that uid. The report names the first file that is not. If the engine cannot start as that user, `gpu<N>-load` fails, and the engine's log tail is in `cards[].failed_loads`. |
| `gpu<N>-stream` | Streams a chat through the public server (`POST /v1/chat/completions` on `:1337`, which routes to the session gateway). The session's own gateway port answers `401` without the session key and `200` with it. Records the time to the first token. |
| `gpu<N>-reload-cached` | Unloads (the container must no longer run once the unload answers), records what the engine cache holds, and loads the same model again. The spec's own check comes first: the engine cache holds files after the first load, and the reload's container mounts the same cache folder as the first one. **Then the second load must be faster than the cold first one.** Both durations are recorded. The model files are in the page cache by then too, so the speed-up is not the engine cache's alone. |
| `gpu<N>-tool-call` | Sends one tool call (`get_weather`) through `:1337` to a model whose family has a `tool_parser` in the descriptor's `model_families`. If the tier model's family has no parser, the test uses the smallest other curated model that fits the card and has one. With no such model the scenario is skipped. The check: `capabilities` declares `tools: true`, the engine was started with `--tool_parser <name>`, and the answer carries a `get_weather` call whose arguments name Paris. |
| `gpu<N>-structured-output` | Sends a chat with `response_format: {type: "json_schema", …}` (city, country and population, all required, no other keys) through `:1337`. The model is the one loaded if its family declares `structured_output: true`, else the smallest curated model the card runs that does. The check: `capabilities` declares structured output, and the answer's content parses as JSON that satisfies the schema (checked by hand: required keys, types, no extra keys). |
| `gpu<N>-structured-output-refused` | For a curated model the card runs whose family has `structured_output: false`: the same request is refused by the core with `400` `unsupported_capability`, both on `:1337` and on the session's own gateway port, so it never reaches the engine. Skipped with the models it checked when no curated family has `structured_output: false` (none in `tensorrt-llm-1.2.1-r1`). |
| `gpu<N>-kill-core` | Loads the tier model again if a capability scenario's load left nothing on the card, so the watchdog measurement is not lost. Measures the heartbeat for 20 s, then sends `kill -9` to the core. The engine container must exit through its watchdog: the exit code is 97, and it exits within the watchdog's own bound (computed from the container's `ATOMIC_WATCHDOG_*` env) plus 30 s. The card's `memory.used` must return to its level before the first load, within `ATOMIC_LIVE_TRT_VRAM_TOLERANCE_MIB`, within 60 s. A new core then starts on the same data folder. The run records whether that core removed the killed core's container, and the next card runs on the new core. |
| `reload-while-other-loads` | Needs a llama.cpp build: `ATOMIC_LIVE_UPSTREAM_BIN` (a CUDA `llama-server`; its whole folder is copied into the run's data folder as a backend pack) and `ATOMIC_LIVE_UPSTREAM_MODEL` (a small GGUF), the same variables as `test/live/llamacpp.test.ts`. Skipped without them. With the first card's tier model loaded, it starts a llama.cpp GPU load, and 250 ms later a TensorRT-LLM reload of the same model with a different context length. Both requests must answer within 30 minutes, whether they succeed or fail. Afterwards `GET /sessions` must hold exactly one GPU chat session, because a llama.cpp session holds every card, and the running TensorRT-LLM containers must match it. The run records both answers and what stayed resident. |

The tier model is the curated model with the largest `vram_tier_bytes` the card holds, among the formats
the card runs. Within that tier the test takes the format that needs the newest card: NVFP4 on Blackwell,
FP8 on Ada and Hopper, BF16 on Ampere. This follows the `note` of each curated entry. For example, an RTX
4090 gets `nvidia/Qwen3-14B-FP8`, an RTX 5090 gets `nvidia/Qwen3-32B-NVFP4`, an RTX 3090 gets
`Qwen/Qwen3-8B`, and an H100 80 GB gets `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-FP8`.
`ATOMIC_LIVE_TRT_MODEL` forces one curated repository on every card.

### Prerequisites

- **The engine is `ready` for your user.** Either the [install test](#install-test-task-218) passed on this
  host with `ATOMIC_LIVE_MANAGED_KEEP_ENGINE=1` (without it, its last scenario removes the engine again), or
  the app or `atc` set the engine up. The install test keeps its state in its own output folder, so
  point this test at it with `ATOMIC_LIVE_MANAGED_ROOT=<install test output folder>/managed`. Without the
  variable, the core uses your normal per-user managed root (`<dataDir>/atomic-managed-runtimes`), which is
  where the app and `atc` keep it.
- **A login that reaches Docker.** The core runs as you, so `docker -H unix:///var/run/docker.sock info`
  must work in the shell you start the test from. After the install test added you to `docker`, open a
  **new** ssh login.
- **Passwordless sudo** (`sudo -n true`), which the test uses to inspect the engine container as root.
- **Driver** at or above the descriptor's `minimum_driver_version`, and a core binary built from the commit
  under test (see [Build and copy](#build-and-copy)).
- **Nothing else on the cards.** Quit the Atomic Chat app, stop other CUDA work, and close desktop sessions
  on the cards if you can. The core never stops another scope's sessions, and they would skew the memory
  check and the VRAM baseline.
- **Port 1337 free**, or set `ATOMIC_LIVE_PUBLIC_PORT`.
- **Disk and network**: `huggingface.co` (or `HF_ENDPOINT`) and room in `~/.cache/atomic-chat-live/hf` for
  each card's tier model, from 4 GB up to about 45 GB for the 80 GB tier. The checkpoints are hard-linked
  into the run's data folder, not copied.
- **Hosts to cover** (the task's acceptance): at least one Ada card (compute capability 8.9) and one
  Blackwell (12.0) or datacenter card (9.0 or 10.0). A host with several cards covers all of them in one
  run.

### Run

From a fresh login on the host, in the checkout that holds the binary. A run takes hours on a multi-card
host, so start `tmux` **inside that login** first: an ssh drop then does not kill it half-way. Do not
attach to a tmux server an older login started, because its sessions may predate your `docker` group.

```sh
tmux new -s engine
cd ~/atomic-chat-core
ATOMIC_LIVE=1 \
ATOMIC_RUNTIME_DESCRIPTOR_URL="file://$HOME/tensorrt-llm.json" \
ATOMIC_ENVIRONMENT_MANIFEST_URL="file://$HOME/linux.json" \
ATOMIC_LIVE_MANAGED_ROOT="$HOME/atomic-chat-core/test/tmp/live-managed-install/<install run>/managed" \
npx vitest run --project live test/live/tensorrt-llm.test.ts 2>&1 \
  | tee "tensorrt-llm-$(hostname)-$(date +%Y%m%d-%H%M).log"
```

Without tmux, `setsid nohup ./run-engine.sh > run-engine.log 2>&1 < /dev/null &` from the same login (the
command above in a script) survives an ssh drop as well.

Leave out `ATOMIC_LIVE_MANAGED_ROOT` when the app or `atc` set the engine up. `ATOMIC_RUNTIME_DESCRIPTOR_URL`
must name the descriptor the engine was installed with, because `preconditions` compares the ids. Until
conf merges, that is the `file://` URL of your copy of `atomic-chat-conf/runtimes/tensorrt-llm.json`.
Without it, the test reads the fixture copy in `test/fixtures/runtimes/tensorrt-llm.json`. An engine
installed from `tensorrt-llm-1.2.1-r1` (the shape with `recipes`, before the environment manifest) is
not served by this core any more: remove it and set it up again from `r2`.
`ATOMIC_ENVIRONMENT_MANIFEST_URL` (default: `test/fixtures/runtimes/environments/linux.json`) goes to
the core the same way; an installed engine never needs the manifest, so it only matters if the run
probes a host that still needs setup.

The only opt-in is `ATOMIC_LIVE=1`, on Linux with `/usr/bin/nvidia-smi`. Anywhere else, every scenario is
skipped with the reason. The CI live job on runners without a GPU is one example. `npm run test:live`
sets `ATOMIC_LIVE=1`, so on an NVIDIA Linux host it runs this test too, downloads included.

Optional variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `ATOMIC_LIVE_CORE_BIN` | `dist/bin/atomic-chat-core-<arch>-unknown-linux-gnu` | the core binary under test |
| `ATOMIC_LIVE_MANAGED_ROOT` | the per-user managed root | where the `ready` engine installation lives; passed to the core as `ATOMIC_CORE_MANAGED_ROOT` |
| `ATOMIC_LIVE_OUT` | `test/tmp/live-tensorrt-llm/<id>-<version>-<arch>-<time>/` | output folder |
| `ATOMIC_LIVE_MODEL_CACHE` | `~/.cache/atomic-chat-live/hf` | downloaded checkpoints, kept across runs and shared with the install test |
| `ATOMIC_LIVE_TRT_MODEL` | each card's tier model | one curated `repository` to load on every card |
| `ATOMIC_LIVE_TRT_CONTEXT_LENGTH` | unset (the provider's 8192) | stored as the run's `context_length` setting (`max_output_tokens` half of it, at most 4096), so the check route and every load reserve KV cache for it; for 8 GB cards |
| `ATOMIC_LIVE_TRT_VRAM_TOLERANCE_MIB` | `512` | how far above its pre-load level a card's memory may settle after the kill |
| `ATOMIC_LIVE_UPSTREAM_BIN`, `ATOMIC_LIVE_UPSTREAM_MODEL` | unset | a CUDA `llama-server` and a GGUF for `reload-while-other-loads`; skipped without them |
| `ATOMIC_LIVE_PUBLIC_PORT` | `1337` | public server port |
| `HF_ENDPOINT`, `HF_TOKEN` | huggingface.co, none | a mirror; curated models are ungated |

No run has been timed yet. Per card, the time goes to the tier model's download on the first run, to its
two loads (the first one cold), to a second model's download and load when the tier model has no tool
parser, and to about two minutes of heartbeat sampling and waiting for the watchdog.

The run unloads the last model and stops its core. The container of a killed core is removed by the next
core, which starts on the same data folder. If a run is interrupted right after a `kill-core` scenario,
the exited container stays. Its id is `cards[].kill.container_id` in `summary.json`. Remove it with
`sudo docker rm <id>`, or start any core on that data folder.

### Where the report lands

In the output folder the test prints on its first log line (`output folder …`):

- `summary.json`: rewritten after every scenario, so an interrupted run still keeps what it proved. It
  holds:
  - `host` (distribution, kernel, driver, GPUs) and `core` (binary sha256, git HEAD, managed root);
  - `source_constants`: every constant the measurements are compared against, with its `src/` file and
    line, read from the checkout at run time;
  - `cards[]`, one entry per card: `name`, `compute_capability`, `driver_version`, `total_bytes`,
    `model` (repository, revision, tier, quantization, architectures, the core's check verdict), and
    `scenarios` (passed, failed or skipped per scenario);
  - per card, `first_load` and `reload` (`load_ms`, `stages`, `weight_bytes`, `readiness_timeout_ms`,
    `load_to_timeout`, `vram_peak_bytes`, `shm_peak_bytes`, `command`), plus `reload_to_first_load`,
    `engine_cache`, `engine_cache_warm`, `shm_peak_bytes`, `container_user`, `failed_loads` (with each failed load's engine log tail), `stream`
    (`first_token_ms`), `tool`, `structured`, `structured_refused` and `kill`;
  - `reload_while_other_loads`: both answers of the residency race and what stayed resident;
- `run.log` (the same lines the console shows, prefixed `[tensorrt-llm …]`) and `core.log` (every core's
  stdout and stderr);
- the `tee`'d console log.

Attach `summary.json`, `run.log`, `core.log` and the console log to the PR, one set per host. Do not attach
`data/`, which holds the models' hard links.

### Carrying the measurements into an ADR

The run does not write an ADR. After the runs on every host, write one ADR from `docs/decisions/_TEMPLATE.md`
and add its line to `docs/decisions/INDEX.md`. It lists every host and card (GPU name, compute capability,
driver, model) and decides each value below. Each placeholder is cited in `source_constants`. Change it at
that file and line in the same change, and reference the ADR there:

| Value | Placeholder in `src/` | Measured in `summary.json` |
| --- | --- | --- |
| Heartbeat interval | `DEFAULT_HEARTBEAT_INTERVAL_SECS` (and the watchdog poll, which follows it) | `cards[].kill.heartbeat_gaps_ms`: min, median and max of how often the core really wrote the file |
| Watchdog stale limit and kill grace | `DEFAULT_WATCHDOG_STALE_LIMIT_SECS`, `DEFAULT_WATCHDOG_KILL_GRACE_SECS` | `cards[].kill.watchdog_env` (what the container got), `observed_staleness_ms` (last heartbeat to container exit), `kill_to_exit_ms`, `watchdog_exit_bound_ms`, and `exit_code` 97 |
| `--shm-size` | `MODEL_CONTAINER_SHM_SIZE` | `cards[].kill.shm_size_bytes` (what the container got) against `cards[].shm_peak_bytes` (the highest `/dev/shm` use sampled during every load, the streamed chat, the tool call and the structured-output call, plus one reading before the kill) |
| Container memory limit | none: the core sets no `--memory` | `cards[].kill.container_memory_limit_bytes` (`0` means Docker sets no limit) |
| Load timeout coefficients | `TENSORRT_LLM_READINESS_BASE_MS`, `TENSORRT_LLM_READINESS_PER_GIB_MS`, `TENSORRT_LLM_READINESS_MARGIN` | `cards[].first_load.load_ms` against `weight_bytes`. A line through the first loads gives the base (intercept) and the per-GiB cost (slope). Every first load is cold as far as the engine cache goes (`engine_cache_warm: true` only says an earlier card's cache was deleted first), but a second card of the same model starts with its files in the page cache, so fit on each model's first card when they differ. The margin must cover the slowest card's first load, which `load_to_timeout` shows as a fraction of today's timeout. `reload.load_ms` shows what the engine cache saves. |

Also note in the ADR the `stages` split (`starting-container` against `initializing-engine`) and the time
to the first token, because they tell users what to expect.

### Carrying the model results into conf

Each card's `model` and `scenarios` in `summary.json` are the input for `curated_models` in
`atomic-chat-conf/runtimes/tensorrt-llm.json`:

- A model whose `load`, `stream` or `reload-cached` failed on its tier's card generation must not stay in
  that tier. Remove it, or move it to the tier where it passed, and recompute nothing else: the
  `inventory_digest` belongs to the revision, not the tier.
- Write the cards it passed on into its `note`, for example "verified on RTX 4090 (8.9) and L40S (8.9)".
- A `tool-call` failure on a family whose `model_families` entry names a `tool_parser` means that parser
  name is wrong for this engine release. Fix `model_families`, not the model list.
- A `structured-output` failure on a family with `structured_output: true` needs a look at
  `cards[].structured` before any change. Set that family's `structured_output` to `false` in
  `model_families` only when `finish_reason` is `stop`, `content` is present, and it is not JSON that fits
  the schema (or the core refused the request): then this engine release does not honour
  `response_format` for that family. When the JSON sits in `reasoning_content` instead, the reasoning
  parser filed it as thinking. When `finish_reason` is `length`, the answer was cut off. Neither says
  anything about `response_format`: take those to the adapter, not to conf. `cards[].tool` records the
  same two fields for a tool call.
- Put the table of hosts and cards (name, compute capability, driver, model, pass or fail per scenario,
  load, reload and first-token times) in the conf PR that changes the list.
