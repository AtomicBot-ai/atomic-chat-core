# Wire and on-disk contracts with the Atomic Chat app

Preserve the behavior and meaningful data below until the corresponding phase of PLAN.md retires the
desktop implementation. Each fixture records its source commit and comparator. Error codes, event names
and meaningful flags compare exactly; dynamic ports, PID, times and paths use explicit normalization.
YAML/JSON compare schema, values, defaults and unknown-field round trips; key order is not a contract
without a demonstrated consumer. See PLAN.md §5.1 for comparison rules and §8 for source behavior.

| Contract | Core location | App source of truth | Fixture |
| --- | --- | --- | --- |
| Error codes `{code,message,details?}` | `src/contracts/errors.ts` | `src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/error.rs` | `test/fixtures/app/errors/*.json` |
| Model-load cancel: `POST /atomic/v1/models/:provider/*id/load/cancel` → `{cancelled}`, error `MODEL_LOAD_CANCELLED` (409, "The model load was cancelled.") | `src/runtime/shared/load-cancel.ts`, `src/core/sessions.ts`, `src/server/control/routes/models.ts` | image-generation line `src-tauri/utils/src/load_cancel.rs`, the three plugins' `error.rs` (`ModelLoadCancelled`), `core/src/browser/extensions/engines/AIEngine.ts` (`MODEL_LOAD_CANCELLED_CODE`) at `767ff6350` | ported test tables (the Rust side is removed on the core-migration line); `test/e2e/load-cancel.test.ts` |
| Disk error tags `[disk_*]` in messages | `src/contracts/errors.ts`, `src/downloads/` | `src-tauri/src/core/downloads/disk.rs`, `web-app/src/lib/telemetry.ts` | `test/fixtures/app/downloads/*.json` |
| `SessionInfo`, `RuntimeDeviceInfo`, `UnloadResult`, `DeviceInfo` | `src/contracts/session.ts` | `guest-js/types.ts:122-132`, `state.rs:9-23`, `runtime_device.rs` | `test/fixtures/app/runtime-device/*.json` (runtime-device), `test/fixtures/app/session/*.json` (planned) |
| `model.yml` schema + values + unknown-field preservation | `src/contracts/model-yml.ts`, `src/models/` | `guest-js/types.ts:142-171`, `src-tauri/src/core/cli/mod.rs:46-58` | `test/fixtures/app/model-yml/*.yml` |
| `llama-server` argv | `src/runtime/llamacpp/args.ts` | `args.rs` | `test/fixtures/app/args/*.json` |
| `llama-server` argv, TurboQuant provider (turbo caches, no Vulkan override, no MTP/DFlash) | `src/runtime/llamacpp/args.ts` | `tauri-plugin-llamacpp/src/args.rs` | `test/fixtures/app/args-llamacpp/*.json` |
| `mlx-server` argv and stderr classification | `src/runtime/mlx/{args,errors}.ts` | `tauri-plugin-mlx/src/{commands,error}.rs` | `test/fixtures/app/mlx-args/*.json`, `test/fixtures/app/mlx-errors/*.json` |
| Foundation Models startup errors | `src/runtime/foundation-models/errors.ts` | `tauri-plugin-foundation-models/src/error.rs` | `test/fixtures/app/foundation-models-errors/*.json` (one case corrected on purpose, asserted in the test) |
| Readiness lines | `src/runtime/shared/process.ts` | `commands.rs:58-63`, `tauri-plugin-mlx/src/commands.rs:284-330`, `tauri-plugin-foundation-models/src/commands.rs:125` | `test/fixtures/app/readiness/*.txt` |
| `--list-devices` parsing | `src/runtime/llamacpp/devices.ts` | `device.rs` | `test/fixtures/app/devices/*.json` |
| Provider settings keys | `src/settings/schema/*.json` | `extensions/*/settings.json` | copied verbatim |
| `<data>` layout | `src/config/` | PLAN.md §8.1 | `test/helpers/tmp-data-folder.ts` |
| Managed runtime layout: shared `<dataDir>/atomic-managed-runtimes/{environment.json, environment.lock, installations/, operations/}` and per-scope `<data>/atomic-core/managed-runtimes/{executions,heartbeats,artifacts,caches}/`; ids are one directory each through percent-encoding; a guest path is never a host path | `src/config/paths.ts` | proposed feature, no app source yet (app ADRs `2026-09-22-share-managed-text-runtime-infrastructure`, `2026-09-22-propose-managed-tensorrt-llm-architecture`) | `src/config/paths.test.ts` |
| `<data>/local-api-server.json` | `src/contracts/control-api.ts`, `src/server/state-file.ts` | `src-tauri/src/core/server/state_file.rs` | `test/fixtures/app/state-file/*.json`, replayed by `test/contract/state-file.test.ts`; one writer at a time: the app's proxy while it serves, the core when started with `state_file: true` (the app's handover) |
| `<data>/atomic-chatgpt-auth.json` v1, ChatGPT OAuth (PKCE, authorize URL, callback, JWT claims, token response) | `src/credentials/chatgpt-{store,oauth,auth}.ts` | `src-tauri/src/core/auth/{store,chatgpt}.rs` | `test/fixtures/app/chatgpt-auth/*.json`, replayed by `test/contract/chatgpt.test.ts` (Node and Bun) |
| ChatGPT subscription route (upstream request, model list normalisation) | `src/cloud/chatgpt.ts`, `src/server/public/subscription.ts` | `src-tauri/src/core/server/chatgpt_route.rs` | `test/fixtures/app/chatgpt-route/*.json`, replayed by `test/contract/chatgpt.test.ts` |
| `<data>/atomic-core/credentials.json` (0600), cloud provider list in `settings.json` `cloud.providers` | `src/credentials/api-keys.ts`, `src/cloud/registry.ts` | `remote_provider_commands.rs` (in-memory map; the app mirrors registrations to `PUT /cloud/providers/:id`) | unit + e2e (`test/e2e/cloud.test.ts`) |
| `/v1/*` routes, gates, CORS, ctx retry, `/messages` fallback, `/responses`, docs | `src/server/public/`, `src/router/` | `src-tauri/src/core/server/proxy.rs` | `test/fixtures/app/proxy-http/*.json` (78 raw HTTP exchanges against a stub upstream), replayed by `test/contract/proxy-http.test.ts` on Node and on Bun (`npm run test:contract:bun`); known divergence: a remote provider's custom headers are sent |
| Dynamic trusted-hosts group per request (tunnel name, accepted socket address); `isValidHost` unchanged | `src/server/public/{dynamic-hosts,index}.ts` | image-generation line `src-tauri/src/core/server/{dynamic_hosts.rs,proxy.rs}` at `767ff6350` | ported `dynamic_hosts.rs` tables; `test/contract/dynamic-hosts.test.ts` (the app's integration test, Node and Bun); the `proxy-http` set replays unchanged with an empty group |
| Remote access: `GET /atomic/v1/remote-access`, `POST …/start`, `POST …/stop`, event `remote-access:status`; status `{state,url,error,blockReason,canStart,canStop,serverHasApiKey}` in the app's camelCase with snake_case codes; start refusals 409 `REMOTE_ACCESS_{SERVER_STOPPED,OPERATION_IN_PROGRESS,STOP_FAILED}` with the app's reason in `details` | `src/contracts/remote-access.ts`, `src/remote-access/`, `src/server/control/routes/remote-access.ts` | image-generation line `src-tauri/src/core/server/remote_access/{mod,commands}.rs`, `web-app/src/types/remoteAccess.ts`, `web-app/src/lib/remoteLan.ts` (`parseRemoteAccessRejection`) at `767ff6350` | ported `tests.rs` state-machine tables (`manager.test.ts`), `status.test.ts`; `test/e2e/remote-access.test.ts` |
| `cloudflared` command line (`tunnel [--config <empty>] --url <origin> --no-autoupdate [--protocol http2]`, no `TUNNEL_*` variables) and output (`https://<words>.trycloudflare.com`, never `api.`; `Registered tunnel connection`) | `src/remote-access/cloudflared-{args,output}.ts` | `remote_access/process.rs` | ported parser and argv tables; a real child in `process.test.ts` |
| Tunnel probe: `GET <url>/openapi.json`, `info.title` = `Atomic Chat API Server Endpoints` | `src/remote-access/probe.ts`, served by `src/server/public/static.ts` | `remote_access/probe.rs` | `probe.test.ts` asserts the marker against the document the public server really serves |
| LAN addresses `GET /atomic/v1/lan-addresses` → `{addresses}` (IPv4, default route first, virtual adapters hidden, CGNAT kept) | `src/remote-access/{lan,lan-probe}.ts`, `src/server/control/routes/remote-access.ts` | image-generation line `remote_access/lan.rs` (`get_lan_addresses`) | ported `lan.rs` tables |
| Image generation wire types (camelCase; absent vs `null` as the plugin's serde produced), the 21 `DiffusionErrorCode`s (statuses informational: 400/404/409/429/507/500), events `diffusion:{state,progress,job,error}` | `src/contracts/{diffusion,errors,events}.ts`, `src/diffusion/{parse,errors}.ts`, `src/server/http.ts` | image-generation line `web-app/src/services/diffusion/types.ts`, plugin `tauri-plugin-atomic-diffusion/src/{state,error,events}.rs` at `767ff6350` | `contracts/errors.test.ts` (code list), `diffusion/parse.test.ts`, `server/http.test.ts` |
| `sd-server` argv and `POST /sdcpp/v1/img_gen` body; output parsing (records, step lines, tile passes, diagnostic tail, exit classification); progress tracking; request validation | `src/diffusion/{args,progress,tracker,validate,workflow}.ts` | plugin `{args,progress,jobs,session}.rs` | the Rust `#[test]` tables ported by hand into the sibling tests; `test/fixtures/sdcpp/required-flags.txt` |
| Gallery files: `<outputDir>/<jobId>-<index:02>.png` with `tEXt` chunks `atomic` (the `ImageRecipe` JSON, every key, `null`s) and `parameters` (A1111 line) right after `IHDR`; `<id>.thumb.png` (≤256 px); `.flags.json` `{id:{pinned,archived}}`. A PNG without a valid `atomic` recipe is foreign: never listed, never deleted | `src/diffusion/{gallery,recipe,png}.ts` | plugin `gallery.rs` at `767ff6350` | ported `gallery.rs` tables; `test/fixtures/png/` (independent encoder, Pillow-checked); read-only run against images written by app v2.0.40 |
| Engine installs `<data>/diffusion/backends/<tag>/<backendId>/` with `.atomic-owned` and `install.json` `{tag,backendId,backend,engine,sha256,installedAtMs}`; the `--help` probe markers `stable-diffusion.cpp` / `--cfg-scale`; model files under `<data>/diffusion/models/` | `src/diffusion/{install,containment}.ts` | plugin `install.rs` | ported `install.rs` tables; read-only run against the engine installed by app v2.0.40 |
| `sd-server` supervision: ready when `GET /v1/models` answers 200 (polled every 300 ms within `startupTimeoutSecs`), `GET /sdcpp/v1/capabilities` read afterwards (404 = another process), SIGTERM → 5 s → SIGKILL; jobs `POST /sdcpp/v1/img_gen` (202 `{id}`, 429 = queue full, 400 = rejected), `GET /sdcpp/v1/jobs/<id>` every 400 ms, `POST …/cancel`, 6 h ceiling; the cancel ladder (native → grace → server stopped, spec kept) | `src/diffusion/{server-process,jobs,session,service}.ts` | plugin `{process,jobs,session,commands,lib}.rs` at `767ff6350`; upstream `examples/server/routes_sdcpp.cpp` | ported `jobs.rs` and `process.rs` tables; `test/helpers/fake-sd-server.mjs` end to end |
| Image-generation control routes, one per `DiffusionService` operation (bodies camelCase, paths only in bodies): `PUT /atomic/v1/diffusion/config` → status, `GET …/status`, `PUT …/output-dir {path}`, `POST …/backends/finalize`, `GET …/backends` → `{backends}`, `POST …/backends/remove {dir}`, `GET …/model-files` → `{files}`, `POST …/model-files/delete {path}`, `POST …/model/load` (answers once served: minutes), `POST …/model/unload`, `GET …/capabilities`, `POST …/idle/touch`, `POST …/jobs` (64 MiB body) → `{jobId}`, `GET …/jobs/:id` → `{job\|null}`, `POST …/jobs/:id/cancel` → `{cancelled, serverStopped}`, `GET …/gallery?offset&limit&includeArchived`, `GET …/gallery/:id` → `{item\|null}`, `POST …/gallery/delete {ids}`, `PATCH …/gallery/:id/flags`, `POST …/gallery/:id/export {targetPath}`; a body that does not fit is 400 `INVALID_REQUEST` with the field in `details` | `src/server/control/routes/diffusion.ts`, `src/client/control-client.ts`, `src/core/{create,atomic-core}.ts` (`diffusion` on the facade; shutdown order public stop → sd-server → chat runtimes) | plugin `commands.rs` at `767ff6350`; app seam `web-app/src/services/diffusion/tauri.ts` (re-pointed in the app branch) | `routes/diffusion.test.ts`, `control-client.test.ts`, `src/core/create.test.ts` on a real core with the fake engine |
| `POST /v1/images/generations` (local, never forwarded): `prompt`, `n` ≤ 4, `size` `WIDTHxHEIGHT` (256–2048, ×16) or `auto`, `seed`, `negative_prompt`, `model` (absent, the id or the display name), `response_format` only `b64_json`; answer `{created, data:[{b64_json}], atomic:{job_id, seed, paths}}`; errors in the OpenAI envelope with codes `invalid_request` 400, `model_not_loaded` 503, `busy` 429, `insufficient_memory` / `cancelled` / `server_error` 500, `timeout` 504 (30 min); trace `backend: atomic-diffusion`, endpoint `images/generations`; image models absent from `/v1/models` | `src/server/public/{images,images-params}.ts` | app `src-tauri/src/core/server/images_route.rs` at `767ff6350` | ported `images_route.rs` tables (`images-params.test.ts`), `images.test.ts` on a real listener, `src/core/create.test.ts` on a real core with the fake engine |
| Responses↔Chat shims | `src/server/shims/{responses,chat-to-responses}.ts` | `responses_shim.rs`, `chat_to_responses_shim.rs` | `test/fixtures/app/{responses-shim,chat-to-responses-shim}/*.json`, replayed by `test/contract/shims.test.ts` |
| Anthropic `/messages` ↔ Chat shim | `src/server/shims/anthropic.ts` | `proxy.rs` (`transform_anthropic_to_openai`, `transform_openai_response_to_anthropic`, `transform_and_forward_stream`) | `test/fixtures/app/anthropic-shim/*.json`, replayed by `test/contract/shims.test.ts`; one recorded case is a known divergence (split `data:` line) |
| Request inspector: prompt preview, stream telemetry, `include_usage` injection | `src/server/public/telemetry.ts` | `src-tauri/src/core/server/request_inspector.rs` | `test/fixtures/app/inspector-telemetry/*.json`, replayed by `test/contract/inspector-telemetry.test.ts` |
| `api:request` event (core → app analytics and API screen) | `src/contracts/events.ts` `ApiRequestEvent`, `src/server/public/trace.ts` | consumers `api_request_analytics.rs` (`observation_from_core`), `request_inspector.rs` (`ingest_core_event`) | app Rust tests with the core's event shapes; `test/e2e/api-events.test.ts` |
| External sessions `PUT/DELETE /external-sessions/:owner`, heartbeat, ctx request/answer | `src/runtime/shared/external-sessions.ts` | `src-tauri/src/core/atomic_core/external.rs` (publisher, `external-sessions:ctx-requested` handler) | unit + `test/e2e/api-events.test.ts` |
| Download progress event `download-<taskId>` `{transferred,total}` | `src/downloads/` | `src-tauri/src/core/downloads/models.rs:66-70` | `test/fixtures/app/downloads/events-*.json` |
| Download stage event `download:stage` `{taskId, stage:{kind:'connecting'\|'retrying', attempt, maxAttempts}}` — a status change, never a progress frame | `src/contracts/events.ts`, `src/downloads/{downloader,protocol}.ts` | image-generation line `src-tauri/src/core/downloads/{models,helpers}.rs` (`DownloadStage`, `StageReporter`) at `767ff6350`; the app's relay maps it onto `download-<taskId>` as `{transferred:0,total:0,stage}` | `src/downloads/downloader.test.ts` (both ladders, the limit, mid-stream silence), `test/e2e/owner.test.ts` (SSE frames during a failing mirror) |
| Free disk space `POST /atomic/v1/disk/available {path?}` → `{bytes\|null}`, inside the data folder only | `src/downloads/disk-space.ts`, `src/server/control/routes/disk.ts` | replaces `plugin:llamacpp-upstream\|available_disk_space`, removed by the core migration; caller `web-app/src/services/diffusion/install.ts` | unit + `test/e2e/owner.test.ts` |
| Legacy event names (17) | `src/contracts/events.ts` → app `CoreEventBridge` | `extensions/llamacpp-upstream-extension/src/index.ts` (`events.emit`) | relay mapping test in the app |

Fixture sets and their comparators (`index.json` names the comparator; `CHECKSUM` is identical in both repos and
checked by `tests/core-contracts.test.mjs` in the app): `args` → `argv-exact`, `errors` → `error-exact`,
`runtime-device` → `runtime-device-exact`, `devices` → `devices-exact`, `responses-shim` /
`chat-to-responses-shim` / `anthropic-shim` → `json-exact` and `sse-sequence`, `state-file` → `state-file-schema`,
`proxy-http` → `http-exchange`, `chatgpt-auth` / `chatgpt-route` / `inspector-telemetry` → `json-exact`.
A case the port deliberately does not reproduce is listed under `comparator_notes.known_divergence` in its set's
`index.json` and asserted as the corrected behaviour, never skipped. A set whose port
has not landed yet is validated for shape only, and `docs/testing-critical-flows.md` lists it as not replayed.

New data paths: `<data>/atomic-core/` (settings.json, credentials.json, optimal-backend.json,
instance.lock, control-token, processes.json, logs/, remote-access-tunnel.json, cloudflared-empty.yml)
and, for the managed text runtimes, `<data>/atomic-core/managed-runtimes/` plus the one root outside
any data folder: `<dataDir>/atomic-managed-runtimes/`, shared by the app and CLI scopes because the
container environment belongs to the machine's user account and must survive a data-folder move
(ADR 2026-09-22-managed-runtimes-split-per-user-environment-from-per-scope-data;
`ATOMIC_CORE_MANAGED_ROOT` overrides it for tests).
Adopted from the app as they are, not new (ADR 2026-09-17-image-generation-is-its-own-module-not-a-local-runtime):
`<data>/diffusion/{backends,models,scratch}` and `<data>/images`. Read once and removed, never written
(ADR 2026-09-18-reap-the-tunnel-atomic-chat-2-0-40-journalled-at-the-data-root): `<data>/remote-access-tunnel.json`,
the tunnel journal of app 2.0.40. Anything else needs an ADR in both repos.

## Target control and ownership contract

The permanent control listener binds only to loopback and requires the control token. The independently
configured public listener exposes inference routes; stopping it does not stop control or unload models.
Public transitions are serialized. The per-request dynamic trusted-hosts group is not part of a listener's identity. Starting the same effective configuration is idempotent; starting a
different host, port, prefix, key or gate while it is running returns `CORE_ALREADY_RUNNING` and leaves
the old listener reachable. Reconfiguration therefore means an explicit stop followed by start.
Tauri uses a Rust command/event relay, not browser fetch to control; the token stays outside the webview.
App and CLI attach to the same owner, survive each other's exit, and reject incompatible owner versions.
Legacy resource guards and an owner-aware reaper are required before distributing the new CLI.

The ready line is `{event:"core:ready", pid, instance_id, protocol, version, control_host, control_port}`,
printed by `daemon` as its first and only stdout line (`src/contracts/control-api.ts`, phase 1).
It describes control readiness only. Public host/port/prefix/running state comes from snapshot and events.
SSE ids are `<instance_id>:<seq>`; snapshot includes a consistent cursor. A different instance or an
expired replay cursor requires resync. Stdout carries no event stream. A restarted owner clears dead
sessions after confirmed orphan cleanup; it never silently retries generation.

Settings transfer per scope before that scope's first core operation. Revisions, imported baseline and
acknowledged legacy mirror detect CLI/downgrade divergence; conflicts need resolution before transfer.
The app acknowledges the revision it mirrored; the core persists the post-acknowledgement revision
(a metadata-only step) as the equivalent mirror point. A stale acknowledgement is rejected, while
a retry of the same acknowledgement does not advance the revision again.
See PLAN.md §3.4–3.6 and the [superseding ADR](decisions/2026-09-15-independent-core-owner-and-migration-contracts.md).
Implemented in phase 1: the instance lock and its process-start identity, the control token,
`/atomic/v1/{health,snapshot,events,clients,sessions,models/:p/*id/{load,unload},server,shutdown}`,
the separate public listener, and the CLI (`daemon`, `serve`, `models list`, `server status`,
`shutdown`). The rest of the route list and the settings-transfer rules remain scaffolding until
their phase.

CLI surface kept compatible with the Rust `jan-cli`: `serve` accepts `--model-path`, `--bin`, `--port`,
`--mmproj`, `--embedding`, `--timeout`, `--n-gpu-layers`, `--ctx-size`, `--fit`, `--threads`,
`--api-key`, `--detach/-d`, `--log`, `--verbose/-v`, `--select`, `--data-folder`, and `--json`.
Its defaults are port 6767, timeout 120 seconds, GPU layers -1, context 32768, fit off and threads 0;
fit forces context 0. `owner/repository` downloads a GGUF into the CLI scope's model tree, preferring
`Q4_K_XL` and validating size/sha256 before writing `model.yml`. `models list`
hides embedding models and prints `{id,name,model_path,size_bytes,capabilities,mmproj_path}` under
`--json`, `server status` exits 1 when nothing answers and reads `ATOMIC_API_KEY`. The deliberate
difference is ownership — `serve` attaches to a core that outlives it, so Ctrl+C detaches instead of
unloading. `--detach` is consequently a compatibility no-op for ownership and selects the default
`<data>/atomic-core/logs/serve.log`; the help text states this difference.
