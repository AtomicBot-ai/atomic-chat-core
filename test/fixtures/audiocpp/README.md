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
