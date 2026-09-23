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
