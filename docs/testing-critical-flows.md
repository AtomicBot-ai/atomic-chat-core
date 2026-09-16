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
| CLI: version, usage, dispatch, exit codes | Strong | `src/cli/main.test.ts` (dispatch to every phase-1 command, a full daemon → serve → shutdown cycle in one process), `src/cli/commands.test.ts`, `test/e2e/{binary,owner}.test.ts` on the compiled binary | maintained |
| Rust contract parity: argv, error cascade, runtime-device, `--list-devices` | Strong (contract) | `test/contract/{args,errors,runtime-device,devices}.test.ts` replay every fixture in `test/fixtures/app/` with the comparator the emitter names; checksum shared with the app | maintained; shim and state-file sets replay in phase 4 |
| Process spawn, readiness markers, timeout, exit-code capture, kill | Partial | `src/runtime/process.test.ts` (real child processes: ready line, health poll, `MODEL_LOAD_TIMED_OUT`, missing exe, SIGTERM→SIGKILL), `test/runtime-compat/spawn.test.ts` | Strong in phase 1 (fake-llama-server) |
| Load a llama.cpp model (23-step plan → argv → readiness) | Strong | `load-plan.test.ts` (pure plan), `runtime.test.ts` (real processes: readiness, device logs, journal failure rollback, auto-unload, chained projector→MTP fallback, startup cancellation, log relay), `test/live/llamacpp.test.ts` against a real `llama-server` + GGUF | maintained; MLX and Foundation Models in phase 5 |
| Unload and session died | Strong | `runtime.test.ts` (SIGTERM→SIGKILL, journal cleared, `session:died` after an external kill), `core.test.ts` (shutdown stops every session), `test/e2e/owner.test.ts` | auto-increase-ctx in phase 3b |
| Backend manifest, selection, install, update, optimal cache | Partial | `src/backend/*.test.ts` (mirror/fallback, install staging, revisioned file CAS/409 and old-cache migration), `test/e2e/owner.test.ts` (compiled owner + actual local TLS proxy/manifest/mirror, checksum failure, ggml-org fallback, cancel, SSE progress, Windows CUDA companion), app `live_tests.rs` (optimal snapshot then SSE and new generation); no UI install/update/cancel acceptance | Strong after real desktop UI acceptance |
| Core-owned batched embeddings | Partial | `src/models/embed.test.ts` (existing/absent session, batching and global indices, one 501 reload, errors), `test/e2e/owner.test.ts` (compiled owner, fake backend returns 501 until reload in embedding mode, two batched inputs and one replacement process); no live RAG request through a running app | Strong after live RAG acceptance |
| Resumable download + verification + disk tags | Strong | `src/downloads/downloader.test.ts` against `test/helpers/fixture-http-server.ts` (Range/206, 200/416 restart, drops, retries, cancel keeps partials, sha256 mismatch, cleanup of file and empty dir, `[disk_*]` preflight) | maintained |
| Proxied downloads: HTTP forward, CONNECT, SOCKS5, proxy auth, `no_proxy`, `ignore_ssl`, Range through the tunnel, abort, redirects | Strong | `src/downloads/proxy-fetch.test.ts` and `test/runtime-compat/proxy-fetch.test.ts` against real loopback proxies; abort is covered during headers, CONNECT, SOCKS and TLS, and truncated Content-Length/chunked bodies reject | compiled-binary run in phase 1 |
| Hugging Face GGUF discovery and download | Strong | `src/models/hf.test.ts` covers repo validation, token precedence/auth, metadata normalization, Q4/largest selection, unsafe filenames, gated/empty errors, sha256 validation and publishing `model.yml` only after success | maintained |
| Settings store: schema, canonical keys, revisions, change events | Partial | `src/settings/store-import.test.ts` (three-way legacy import, conflict, idempotent and stale acknowledgement); `test/e2e/owner.test.ts` imports, edits through control, resolves a 409, acknowledges, restarts a compiled owner and checks `in_sync` before/after another edit. The post-write revision defect is fixed; desktop downgrade flow is not covered. | Run real desktop rollback acceptance |
| Speculative registries (DFlash / MTP / EAGLE-3 / transcription / template overrides) | Partial | `src/speculative/*.test.ts` (table-driven resolution, verbatim port) | Strong in phase 5 |
| Forwarding `/v1` to a session (models, completions, SSE, cancel) | Strong | `src/server/public.test.ts` (upstream key attached, stream passthrough, client hang-up aborts the backend request, 404 for an unloaded model, 502 for an unreachable one), `test/e2e/owner.test.ts` (stream and cancel through the compiled binary) | cloud routing in phase 4 |
| Server gates: host, api key, CORS | Partial | `src/server/public.test.ts` (API key as Bearer or `X-Api-Key`, untrusted `Host` refused, CORS only when enabled), `http.test.ts` (loopback and DNS-rebinding guards) | Strong in phase 4 with the full proxy |
| ChatGPT OAuth + token refresh | Missing | — | Strong in phase 4 |
| Instance lock, concurrent launch, CLI attach, PID reuse | Strong | `src/lock/*.test.ts` (four racing starters yield one owner; dead pid, reused pid and unprovable identity each handled; stale takeover mutex), `src/cli/owner.test.ts`, `test/e2e/owner.test.ts` (two simultaneous `serve` launchers converge on one daemon; second explicit owner refused) | maintained |
| Independent control/public listeners; client detach and explicit shutdown | Strong | `src/server/control.test.ts`, `core.test.ts` (idempotent compatible starts, incompatible conflict preserves traffic, bind failure, lifecycle rejects new work), `runtime.test.ts` (in-flight startup cancelled and child killed), `test/e2e/owner.test.ts` (two clients, explicit shutdown, no orphan) | maintained |
| Legacy resource guard; reaper preserves live owner and backend | Missing | — | Strong before distribution in phase 2 |
| Crash cleanup; snapshot/SSE resync | Partial | `lock/process-journal.test.ts` + `core.test.ts` (orphan policy), `test/e2e/owner.test.ts` (killed owner and backend reap), `control.test.ts` and `client/control-client.test.ts` (cursor replay/resync); app `make test-core-live` (production relay starts owner, recovers after kill, snapshot precedes deltas, replacement generation and fourth restart refused). Webview state after resync is not tested. | Strong after app-UI snapshot/resync acceptance |
| All session consumers and registered legacy TurboQuant/MLX/FM capabilities | Missing | — | Strong in phase 4, core lookup in phase 3b |
| Final signed universal artifact executes on macOS arm64 and x64 | Missing | — | Strong in phase 2 |
| Control API over the wire (auth, host gate, snapshot, clients, SSE) | Strong | `src/server/control.test.ts` and `src/client/control-client.test.ts` drive a real server over a socket; `test/e2e/owner.test.ts` does the same against the compiled binary | maintained |
| Mobile paths survive desktop legacy removal | Missing | — | Existing mobile build/contract checks in phase 6 |
