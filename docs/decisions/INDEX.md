# Engineering Decisions (ADR)

One decision per file. Append-only: never edit or delete an existing record — if a decision is reversed,
add a new one that says which record it supersedes.

**Adding a record**

1. Copy `_TEMPLATE.md` → `docs/decisions/YYYY-MM-DD-short-slug.md` and fill it in.
2. Add one line to this index.
3. Do **not** paste the record body into `AGENTS.md`.

## Records

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
