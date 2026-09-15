# Test helpers

- `fake-llama-server.ts` — a Node script that behaves like `llama-server` for tests: prints the real
  startup lines (`listening on`, `load_backend: loaded CUDA backend`, `offloaded 33/33 layers to GPU`),
  serves `/health`, `/props`, `/apply-template`, `/tokenize`, `/v1/chat/completions` (SSE), and can be told
  to exit with a code/signal or hang. Spawned via `process.execPath`, so it works under Node and Bun.
- `fixture-http-server.ts` — scripted `node:http` server with Range/206/416 support, sha256 bodies and
  injected failures for download tests.
- `tmp-data-folder.ts` — creates a throwaway `<data>` with the app's layout (`llamacpp/models/...`).
