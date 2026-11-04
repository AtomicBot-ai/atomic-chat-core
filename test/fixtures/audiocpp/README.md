# audio.cpp fixtures

Captured from upstream `0xShug0/audio.cpp` `v0.9.3` (`audio-v0.9.3-bin-macos-arm64-metal.tar.gz`) on an
Apple M4 Pro, 2026-10-29. Paths in the model listings are replaced with `/models/<file>`.

| File | Command |
| --- | --- |
| `help.txt` | `audiocpp_server --help` (exit 0) |
| `version-macos-arm64.txt` | `audiocpp_server --version` (exit 0) |
| `list-devices-macos-arm64.txt` | `audiocpp_server --list-devices --json` (exit 0; v0.9.3 prints text, not JSON) |
| `no-config.txt` | `audiocpp_server` with no arguments (exit 1) |
| `health.json` | `GET /health` of a server started with one model and `lazy_load: false` |
| `models-qwen3-tts.json` | `GET /v1/models?include_params=true` of a Qwen3-TTS 0.6B Base server |

## `conf/`

conf manifests (`backends/audiocpp-manifest*.json` of `AtomicBot-ai/atomic-chat-conf`), the sd.cpp
document's shape:

| File | What |
| --- | --- |
| `audiocpp-manifest.staging.json` | conf's bootstrap staging manifest, verbatim (conf commit `4c5fb98`): upstream `0xShug0/audio.cpp` `v0.9.3`, no `download_base`, upstream's `.tar.gz`/`.zip` names |
| `audiocpp-manifest.json` | a fork build as the mirror publishes it (hand-made): `v0.9.3-a1b2c3d4`, `download_base`, every backend id of the schema plus the cudart companion; the hashes are of the names, not of real archives |

## `engine-contract.json`

The engine contract the engine candidate check holds an audio.cpp build to (`engine=audio-cpp`,
`scripts/lib/audiocpp-surface.mjs`): the flags core passes and the routes it calls (found in `--help`),
the install probe's `--version` marker, the archives by backend id (conf's `mirror-audiocpp.yml`
mapping), and the upstream sources they live in. Written by hand; `test/contract/audiocpp-engine-contract.test.ts`
holds it to `v0.9.3/help.txt`, `src/audio` and `src/engine-builds`.

## `releases/`

GitHub releases as `{repo, tag, published_at, target_commitish, assets: [{name, size, digest}]}`:

| File | What |
| --- | --- |
| `v0.9.3.json` | upstream `0xShug0/audio.cpp` `v0.9.3`, verbatim from the API (2026-10-29) |
| `v0.9.3-a1b2c3d4.json` | conf's signed mirror of a fork build (hand-made): the archives of `conf/audiocpp-manifest.json` with its sizes and sha256 as digests, plus `SHA256SUMS` |
