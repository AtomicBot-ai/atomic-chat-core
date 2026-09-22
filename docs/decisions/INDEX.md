# Engineering Decisions (ADR)

One decision per file. Append-only: never edit or delete an existing record — if a decision is reversed,
add a new one that says which record it supersedes.

**Adding a record**

1. Copy `_TEMPLATE.md` → `docs/decisions/YYYY-MM-DD-short-slug.md` and fill it in.
2. Add one line to this index.
3. Do **not** paste the record body into `AGENTS.md`.

## Records

- **2026-09-22** — [Two things Bun's node:http does not tell the server: a client that hangs up before the answer, and an answer written before the body is read](2026-09-22-detect-a-client-that-hangs-up-before-the-answer-under-bun.md) — qualifies the 2026-09-15 Node-compatible-API decision with two confined work-arounds pinned under both runtimes.
- **2026-09-22** — [The core owns its error reporting](2026-09-22-the-core-owns-its-error-reporting.md) — supersedes the app-only parts of the 2026-09-21 Sentry record.
- **2026-09-21** — [Report core errors to its own Sentry project](2026-09-21-report-core-errors-to-its-own-sentry-project.md)
- **2026-09-21** — [Image generation follows app v2.0.42: engine gating, output checks, finalize under the load lock](2026-09-21-diffusion-follows-app-v2-0-42-engine-gating-and-output-checks.md)
- **2026-09-21** — [Configure ZCode for launch through its provider file, pinned by ported tests instead of golden fixtures](2026-09-21-configure-zcode-for-launch-without-golden-fixtures.md)
- **2026-09-21** — [Classify llama.cpp failures per provider](2026-09-21-classify-llama-cpp-failures-per-provider.md)
- **2026-09-18** — [Reap the tunnel Atomic Chat 2.0.40 journalled at the data root](2026-09-18-reap-the-tunnel-atomic-chat-2-0-40-journalled-at-the-data-root.md)
- **2026-09-18** — [Serve /v1/images/generations locally from the job runner](2026-09-18-serve-images-generations-locally-from-the-job-runner.md)
- **2026-09-17** — [A minimal PNG codec on node:zlib for recipes and thumbnails](2026-09-17-a-minimal-png-codec-on-node-zlib-for-recipes-and-thumbnails.md)
- **2026-09-17** — [Image generation is its own module, not a local runtime](2026-09-17-image-generation-is-its-own-module-not-a-local-runtime.md)
- **2026-09-17** — [The diffusion surface speaks the app's camelCase and error codes verbatim](2026-09-17-diffusion-speaks-the-apps-camelcase-and-error-codes-verbatim.md)
- **2026-09-17** — [spawnManaged reports raw chunks and can skip capturing output](2026-09-17-spawnmanaged-reports-raw-chunks-and-can-skip-capturing-output.md)
- **2026-09-17** — [Pin the diffusion port with hand-ported test tables and a live test](2026-09-17-pin-the-diffusion-port-with-hand-ported-tables-and-a-live-test.md)
- **2026-09-17** — [The core owns the Cloudflare quick tunnel next to the public listener](2026-09-17-the-core-owns-the-cloudflare-quick-tunnel.md)
- **2026-09-17** — [Probe the tunnel through the raw-socket client with an address pin](2026-09-17-probe-the-tunnel-through-the-raw-socket-client-with-an-address-pin.md)
- **2026-09-17** — [Trust the live tunnel name and the accepted socket's address as a per-request group](2026-09-17-trust-the-tunnel-name-and-the-accepted-socket-address-per-request.md)
- **2026-09-17** — [Report download stages as their own event, and answer free disk space inside the data folder](2026-09-17-report-download-stages-as-their-own-event.md)
- **2026-09-17** — [Cancel a model load through a shared per-model registry outside the transition queue](2026-09-17-cancel-a-model-load-through-a-shared-registry.md)
- **2026-09-17** — [Validate downloaded macOS backends and repair installed upstream CUDA packs](2026-09-17-validate-downloaded-macos-backends-and-repair-upstream-cuda.md)
- **2026-09-17** — [Serialize sidecar load and unload before releasing a model claim](2026-09-17-serialize-sidecar-load-and-unload.md)
- **2026-09-17** — [Bind cloud keys to destinations and lease CLI operations](2026-09-17-bind-cloud-keys-and-lease-cli-operations.md)
- **2026-09-17** — [Isolate app and CLI core owners](2026-09-17-isolate-app-and-cli-owners.md)
- **2026-09-16** — [Acknowledge the post-write settings revision](2026-09-16-acknowledge-the-post-write-settings-revision.md)
- **2026-09-16** — [Test stage 3 through hermetic process boundaries](2026-09-16-test-stage3-through-hermetic-process-boundaries.md)
- **2026-09-16** — [Revision optimal cache and complete internal backend and embedding routes](2026-09-16-revision-optimal-cache-and-complete-internal-control-routes.md)
- **2026-09-15** — [Core is TypeScript on a Node-compatible API, packaged with Bun](2026-09-15-core-is-typescript-node-compatible-api-packaged-with-bun.md)
- **2026-09-15** — [Sidecar control protocol is HTTP `/atomic/v1` + SSE with a stdout ready line](2026-09-15-sidecar-control-protocol-is-http-plus-sse.md) — superseded the same day, kept as record.
- **2026-09-15** — [Independent core owner and migration contracts](2026-09-15-independent-core-owner-and-migration-contracts.md) — supersedes shared-listener/parent-liveness design and qualifies the Node SEA fallback claim.
- **2026-09-15** — [Proxied downloads use a raw-socket HTTP client, not undici or agent overrides](2026-09-15-proxied-downloads-use-a-raw-socket-client.md)
- **2026-09-15** — [backend/ keeps one Rust-derived category function and explicit recheck outcomes](2026-09-15-backend-module-uses-one-category-function-and-explicit-outcomes.md)
- **2026-09-15** — [Serialize owner lifecycle and preserve serve flags](2026-09-15-serialize-owner-lifecycle-and-preserve-serve-flags.md)
