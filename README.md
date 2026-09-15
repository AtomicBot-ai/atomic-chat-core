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
