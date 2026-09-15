# Wire and on-disk contracts with the Atomic Chat app

Preserve the behavior and meaningful data below until the corresponding phase of PLAN.md retires the
desktop implementation. Each fixture records its source commit and comparator. Error codes, event names
and meaningful flags compare exactly; dynamic ports, PID, times and paths use explicit normalization.
YAML/JSON compare schema, values, defaults and unknown-field round trips; key order is not a contract
without a demonstrated consumer. See PLAN.md §5.1 for comparison rules and §8 for source behavior.

| Contract | Core location | App source of truth | Fixture |
| --- | --- | --- | --- |
| Error codes `{code,message,details?}` | `src/contracts/errors.ts` | `src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/error.rs` | `test/fixtures/app/errors/*.json` |
| Disk error tags `[disk_*]` in messages | `src/contracts/errors.ts`, `src/downloads/` | `src-tauri/src/core/downloads/disk.rs`, `web-app/src/lib/telemetry.ts` | `test/fixtures/app/downloads/*.json` |
| `SessionInfo`, `RuntimeDeviceInfo`, `UnloadResult`, `DeviceInfo` | `src/contracts/session.ts` | `guest-js/types.ts:122-132`, `state.rs:9-23`, `runtime_device.rs` | `test/fixtures/app/runtime-device/*.json` (runtime-device), `test/fixtures/app/session/*.json` (planned) |
| `model.yml` schema + values + unknown-field preservation | `src/contracts/model-yml.ts`, `src/models/` | `guest-js/types.ts:142-171`, `src-tauri/src/core/cli/mod.rs:46-58` | `test/fixtures/app/model-yml/*.yml` |
| `llama-server` argv | `src/runtime/llamacpp/args.ts` | `args.rs` | `test/fixtures/app/args/*.json` |
| Readiness lines | `src/runtime/process.ts` | `commands.rs:58-63`, `tauri-plugin-mlx/src/commands.rs:284-330`, `tauri-plugin-foundation-models/src/commands.rs:125` | `test/fixtures/app/readiness/*.txt` |
| `--list-devices` parsing | `src/runtime/llamacpp/devices.ts` | `device.rs` | `test/fixtures/app/devices/*.json` |
| Provider settings keys | `src/settings/schema/*.json` | `extensions/*/settings.json` | copied verbatim |
| `<data>` layout | `src/config/` | PLAN.md §8.1 | `test/helpers/tmp-data-folder.ts` |
| `<data>/local-api-server.json` | `src/contracts/control-api.ts`, `src/server/state-file.ts` | `src-tauri/src/core/server/state_file.rs` | `test/fixtures/app/state-file/*.json` (emitted in phase 0, replayed in phase 4) |
| `<data>/atomic-chatgpt-auth.json` v1 | `src/credentials/` | `src-tauri/src/core/auth/store.rs` | `test/fixtures/app/chatgpt-auth/*.json` |
| `/v1/*` routes, gates, CORS allowlist | `src/server/` | `src-tauri/src/core/server/proxy.rs` | `test/fixtures/app/proxy/*.json`, `/openapi.json` |
| Responses↔Chat shims | `src/server/shims/` | `responses_shim.rs`, `chat_to_responses_shim.rs` | `test/fixtures/app/{responses-shim,chat-to-responses-shim}/*.json` (emitted in phase 0, replayed in phase 4) |
| Download progress event `download-<taskId>` `{transferred,total}` | `src/downloads/` | `src-tauri/src/core/downloads/models.rs:66-70` | `test/fixtures/app/downloads/events-*.json` |
| Legacy event names (17) | `src/contracts/events.ts` → app `CoreEventBridge` | `extensions/llamacpp-upstream-extension/src/index.ts` (`events.emit`) | relay mapping test in the app |

Fixture sets and their comparators (`index.json` names the comparator; `CHECKSUM` is identical in both repos and
checked by `tests/core-contracts.test.mjs` in the app): `args` → `argv-exact`, `errors` → `error-exact`,
`runtime-device` → `runtime-device-exact`, `devices` → `devices-exact`, `responses-shim` /
`chat-to-responses-shim` → `json-exact` and `sse-sequence`, `state-file` → `state-file-schema`. A set whose port
has not landed yet is validated for shape only, and `docs/testing-critical-flows.md` lists it as not replayed.

New data paths: only `<data>/atomic-core/` (settings.json, credentials.json, optimal-backend.json,
instance.lock, control-token, processes.json, logs/). Anything else needs an ADR in both repos.

## Target control and ownership contract

The permanent control listener binds only to loopback and requires the control token. The independently
configured public listener exposes inference routes; stopping it does not stop control or unload models.
Tauri uses a Rust command/event relay, not browser fetch to control; the token stays outside the webview.
App and CLI attach to the same owner, survive each other's exit, and reject incompatible owner versions.
Legacy resource guards and an owner-aware reaper are required before distributing the new CLI.

The target ready line is `{event:"core:ready", pid, instance_id, protocol, version, control_host, control_port}`.
It describes control readiness only. Public host/port/prefix/running state comes from snapshot and events.
SSE ids are `<instance_id>:<seq>`; snapshot includes a consistent cursor. A different instance or an
expired replay cursor requires resync. Stdout carries no event stream. A restarted owner clears dead
sessions after confirmed orphan cleanup; it never silently retries generation.

Settings transfer per scope before that scope's first core operation. Revisions, imported baseline and
acknowledged legacy mirror detect CLI/downgrade divergence; conflicts need resolution before transfer.
See PLAN.md §3.4–3.6 and the [superseding ADR](decisions/2026-09-15-independent-core-owner-and-migration-contracts.md).
These are planned contracts: existing TypeScript declarations remain scaffolding until their implementation phase.
