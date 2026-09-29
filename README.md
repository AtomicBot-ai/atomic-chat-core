# atomic-chat-core

TypeScript inference core of [Atomic Chat](https://github.com/AtomicBot-ai/Atomic-Chat): local llama.cpp /
MLX / Apple Foundation Models runtime, backend and model management, cloud providers, model router and the
OpenAI-compatible server on `http://localhost:1337/v1`.

- Working in this repo: [`AGENTS.md`](AGENTS.md)
- The plan, architecture and port-spec: [`PLAN.md`](PLAN.md)
- Decisions: [`docs/decisions/INDEX.md`](docs/decisions/INDEX.md)

```bash
bun install
npm run verify
```

Phase-1 CLI examples:

```bash
atomic-chat-core serve owner/repository --select
atomic-chat-core serve --model-path ./model.gguf --bin ./llama-server --port 6767
atomic-chat-core models list --json
atomic-chat-core shutdown
```

`serve` attaches to the one persistent owner for the selected data folder. The command can exit
without unloading the model; `shutdown` explicitly stops that owner and its sessions.

## Managed runtimes (Linux + NVIDIA)

On Linux with an NVIDIA GPU, the core can also run a model inside a container it manages itself —
today `tensorrt-llm`, NVIDIA's inference engine — instead of spawning a local process the way
llama.cpp and MLX do. It needs Docker and the NVIDIA Container Toolkit, which the core never installs
on its own: setting one up computes a plan, asks for consent, and then runs the one privileged step
(package install, `docker` group membership) through a helper the app or CLI runs as root — the core
itself never gains elevated rights. A step that adds you to the `docker` group waits for your next
sign-in before it can continue. See [`docs/contracts.md`](docs/contracts.md) for the control routes,
the host-step file protocol and exit codes, the on-disk layout, and the `model.yml` shape a managed
model's directory needs.

Installing by hand runs the same steps the setup does: Docker Engine and the NVIDIA Container Toolkit
from their vendors' own `apt` or `dnf` repositories, for the distributions the runtime descriptor
qualifies (see `atomic-chat-conf/runtimes/`), then the NVIDIA runtime registered with Docker and the
invoking user added to the `docker` group. Nothing is ever removed or upgraded on the host.

Live tests that actually install this on a real Linux VM are opt-in and change the machine — see
[`docs/live-tests.md`](docs/live-tests.md) for what they do and the environment variables that gate
them (`ATOMIC_LIVE`, `ATOMIC_LIVE_MANAGED`, `ATOMIC_RUNTIME_DESCRIPTOR_URL`, ...).

## Releasing

The desktop app pins a core version (`atomicCore.version` in its `package.json`) and downloads that
release's binaries, checking them against `SHA256SUMS`.

```bash
make release                 # patch; or VERSION=minor, major, or an explicit X.Y.Z
```

It bumps `package.json` and `src/version.ts` together, commits `release: vX.Y.Z`, tags it and pushes
the branch and the tag (the current version, given explicitly, only tags `HEAD`). Without make:
`npm run release -- patch --push`, or leave out `--push` to look before pushing. The tag runs the
`release` workflow: the same gates as CI on macOS, Linux and Windows (Linux and Windows on x64 and arm64), both
binaries cross-compiled for every target (macOS arm64 and x64, Windows x64 and arm64, Linux x64 and arm64), then
`vX.Y.Z` published with the binaries and `SHA256SUMS` as the latest release.

The workflow can also be started by hand for the version already in `package.json` on a branch
(Actions → release → Run workflow, or `gh workflow run release.yml --ref <branch>`); it creates the
tag itself. A published version is never replaced: a second run for it fails, so bump first.
