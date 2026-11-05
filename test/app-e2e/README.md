# App-E2E

Proves the Tauri app and this core see the same world. Needs `../Atomic-Chat` checked out and, for the
UI scenarios, a built app. See `docs/app-e2e.md`. These tests are skipped unless `ATOMIC_APP_E2E=1`.

`telemetry.test.ts` launches the app's isolated WebDriver build with a scripted llama.cpp engine.
It flips consent through the same Tauri command used by the frontend, checks the state from the
running core, then checks the public error and the envelopes received by a loopback ingest.
The required app build has the `e2e` feature and a compile-time loopback desktop DSN so consent
can turn on. The ordinary app e2e target deliberately clears that DSN.

For a clean macOS arm64 checkout with the app prerequisites installed, run from the core root:

```sh
proof=$(mktemp -d)
(
  cd ../Atomic-Chat
  sed 's|SENTRY_DSN_DESKTOP= |SENTRY_DSN_DESKTOP=http://fixture@127.0.0.1:9/1 SENTRY_ENVIRONMENT=prerelease |' Makefile > "$proof/Makefile"
  make -f "$proof/Makefile" build-app-e2e E2E_TARGET_DIR="$proof/target"
)
ATOMIC_APP_E2E=1 ATOMIC_CORE_BIN="$PWD/dist/bin/atomic-chat-app-core-aarch64-apple-darwin" \
  ATOMIC_E2E_APP_BIN="$proof/target/debug/Atomic-Chat" npm run test:app-e2e
```

Use a release-like resource set. The app harness considers a manually installed TurboQuant pack
in the debug resources or source-tree fallback an unexpected installation. An isolated copy
of the app's test harness can be selected with `ATOMIC_APP_E2E_HARNESS`. Keep its process
isolation and teardown assertions enabled.

## Upstream ROCm on a Linux x64 desktop

Use an isolated app profile on a supported Radeon with the ROCm userspace installed and an
approved ROCm 10.0 archive in the test release catalog. In the llama.cpp upstream provider's
backend settings, recheck the recommendation, install the recommended Linux ROCm pack, then
load a small GGUF and send a chat message. Check that the reply completes and the engine log
reports model layers offloaded to `ROCm0`. Repeat the recommendation with a catalog containing
only CPU and Vulkan for this host and check that Vulkan is offered. The desktop WebDriver
harness currently lacks Linux operator-profile isolation, so this scenario needs a Linux machine.
