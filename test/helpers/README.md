# Test helpers

- `fake-llama-server.ts` — a Node script that behaves like `llama-server` for tests: prints the real
  startup lines (`listening on`, `load_backend: loaded CUDA backend`, `offloaded 33/33 layers to GPU`),
  serves `/health`, `/props`, `/apply-template`, `/tokenize`, `/v1/chat/completions` (SSE), and can be told
  to exit with a code/signal or hang. Spawned via `process.execPath`, so it works under Node and Bun.
- `fixture-http-server.ts` — scripted `node:http` server with Range/206/416 support, sha256 bodies and
  injected failures for download tests.
- `tmp-data-folder.ts` — creates a throwaway `<data>` with the app's layout (`llamacpp/models/...`).
- `compiled-core.ts` — drives the compiled binaries from `test/e2e/`: a daemon on a data folder, the
  control API with its token, a fake `llama-server` pack, reaping of journalled children. No imports from `src/`.
- `compiled-diffusion.ts` — the same for image generation: an owned fake engine tree, model files, the
  app's config → finalize → load sequence, the job poll, the process journal and a structured reader of
  the event stream. No imports from `src/`.
- `fake-sd-server.ts` / `.mjs` — a stand-in for stable-diffusion.cpp's `sd-server` with the modes and
  switches its header lists. The app's desktop e2e suite imports `installFakeSdEngine` and
  `writeFakeSdLaunchers` by path (`docs/app-e2e.md`), so their signatures are a contract.
- `fake-cloudflared.ts` / `.mjs` — a stand-in for `cloudflared tunnel`, likewise imported by path from the app.
