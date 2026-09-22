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

1. Bump `version` in `package.json` and `CORE_VERSION` in `src/version.ts` together
   (`src/version.test.ts` fails otherwise), commit and push.
2. Run the `release` workflow on that branch: Actions → release → Run workflow, or

   ```bash
   gh workflow run release.yml --ref main
   ```

It runs the same gates as CI on macOS, Linux and Windows, cross-compiles both binaries for every
target, then publishes `v<version>` with the binaries and `SHA256SUMS` as the latest release. Pushing
a `v*` tag that matches `package.json` does the same. A published version is never replaced: running
the workflow again for it fails, so bump the version first.
