# Critical flows — test evidence

An evidence map, not a coverage dashboard. Grades (same rules as the app):

- **Strong** — a test enters through a production entry point, asserts an observable outcome, covers a
  failure path, and crosses a real layer boundary (process, file system, socket).
- **Partial** — two or three of the above.
- **Smoke** — the code runs and does not throw.
- **Missing** — no test.

Line coverage alone never raises a grade. A PR may not lower a grade.

| Flow | Grade | Evidence | Phase target |
| --- | --- | --- | --- |
| CLI `--version` / usage / unknown command | Smoke | `src/cli/main.test.ts`, `test/e2e/binary.test.ts` | Strong in phase 1 |
| Rust contract parity: argv, error cascade, runtime-device, `--list-devices` | Strong (contract) | `test/contract/{args,errors,runtime-device,devices}.test.ts` replay every fixture in `test/fixtures/app/` with the comparator the emitter names; checksum shared with the app | maintained; shim and state-file sets replay in phase 4 |
| Process spawn, readiness markers, timeout, exit-code capture, kill | Partial | `src/runtime/process.test.ts` (real child processes: ready line, health poll, `MODEL_LOAD_TIMED_OUT`, missing exe, SIGTERM→SIGKILL), `test/runtime-compat/spawn.test.ts` | Strong in phase 1 (fake-llama-server) |
| Load a llama.cpp model (23-step plan → argv → readiness) | Partial | `src/runtime/llamacpp/load-plan.test.ts` (plan with injected facts: sentinel, AVX, shards, artifacts, template override, MTP/DFlash gates, ctx clamp, retries), `args.test.ts`; no process boundary yet | Strong in phase 1 |
| Unload / session died / auto-increase-ctx | Missing | — | Strong in phase 3b |
| Backend manifest, selection, install, update, optimal cache | Partial | `src/backend/*.test.ts` (manifest transports and baseline fallback, CUDA family, version parsing, selection, archive layout); no real download or install | Strong in phase 3c |
| Resumable download + verification + disk tags | Strong | `src/downloads/downloader.test.ts` against `test/helpers/fixture-http-server.ts` (Range/206, 200/416 restart, drops, retries, cancel keeps partials, sha256 mismatch, cleanup of file and empty dir, `[disk_*]` preflight) | maintained |
| Proxied downloads: HTTP forward, CONNECT, SOCKS5, proxy auth, `no_proxy`, `ignore_ssl`, Range through the tunnel, abort, redirects | Strong | `src/downloads/proxy-fetch.test.ts` and `test/runtime-compat/proxy-fetch.test.ts` against `test/helpers/proxy-servers.ts` (real loopback proxies that journal what they carried; failure paths 407, bad SOCKS auth, untrusted cert); runs under Node and `bun test`, not yet on the compiled binary | compiled-binary run in phase 1 |
| Settings store: schema, canonical keys, revisions, change events | Partial | `src/settings/store.test.ts` (file store, `.tmp`+rename, revision conflict); legacy import and downgrade conflicts not implemented | Strong in phase 3b |
| Speculative registries (DFlash / MTP / EAGLE-3 / transcription / template overrides) | Partial | `src/speculative/*.test.ts` (table-driven resolution, verbatim port) | Strong in phase 5 |
| Router: model → cloud / local, 503 / 404 | Missing | — | Strong in phase 4 |
| Server gates: host, api key, CORS | Missing | — | Strong in phase 4 |
| ChatGPT OAuth + token refresh | Missing | — | Strong in phase 4 |
| Instance lock + concurrent launch + CLI attach + PID reuse | Missing | — | Strong in phase 1 |
| Independent control/public listeners; client detach and explicit shutdown | Missing | — | Strong in phase 1 |
| Legacy resource guard; reaper preserves live owner and backend | Missing | — | Strong before distribution in phase 2 |
| Crash cleanup; snapshot/SSE resync and invalidation of dead sessions | Missing | — | Strong in phase 3a, binary recovery in phase 1 |
| All session consumers and registered legacy TurboQuant/MLX/FM capabilities | Missing | — | Strong in phase 4, core lookup in phase 3b |
| Final signed universal artifact executes on macOS arm64 and x64 | Missing | — | Strong in phase 2 |
| Mobile paths survive desktop legacy removal | Missing | — | Existing mobile build/contract checks in phase 6 |
