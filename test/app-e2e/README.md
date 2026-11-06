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

## FastFlowLM engine updates

On Windows 11 x64 or Linux x64, point the app-owned core at a fixture FLM build manifest. From the app's engine settings, install the first revision, then offer a higher Atomic revision. A broken checksum or local-only identity must leave the first revision active after a refresh and app restart. With a valid archive, the second revision becomes active and the first becomes removable. Check that the model directory contents and driver state survive both attempts. Run this scenario when the desktop FastFlowLM integration is available.

## FastFlowLM model preflight

Once the desktop installer is wired, open the Qwen3 staging entry with a supported host and no engine. Expect the engine requirement before any model bytes transfer. Install the verified engine, then interrupt a model install before its completion marker. Refresh the library and confirm the partial variant is absent. Complete the install and compare the local check's checkpoint, context and files to the selected variant. Disconnect from the network, corrupt one same-sized model file and refresh. Expect an invalid installation while the corrupted bytes remain available for the installer to replace.

## FastFlowLM accelerator readiness

From the app-owned core, request the accelerator list on an XDNA2 machine before driver installation. Verify that the PCI identity survives and the UI can display the driver blocker. After installing the qualified engine and driver, repeat as a standard desktop user and compare the reported account and PCI address with the machine. On Linux repeat through a service with a lower soft memlock limit and verify that the client reports that service and the effective limit. The desktop UI scenario runs when the preparation integration is available.

## FastFlowLM preparation plan

From the desktop runtime settings, probe a ready offline host, a failing Arch installation and a qualified fixture Ubuntu installation. Compare the account and service with the app-owned process. Only the qualified Ubuntu fixture should show the exact proposed packages or account changes. Repeat after changing the fixture revision and check the displayed plan updates. Run this scenario when the desktop preparation UI is available.

## FastFlowLM Windows driver preparation

With a qualified configuration on a test Windows 11 x64 XDNA2 host, compare the displayed device, driver version and publisher with Device Manager. Decline the first UAC prompt and confirm that no helper ran. Approve a fresh request on a host missing the required driver. Confirm that other devices keep their drivers and that a restart request leaves the machine running. After any restart, inspect readiness under the actual runtime account. With a newer working driver, the helper should report the step already satisfied. This desktop scenario requires the later preparation coordinator and UI.

For FastFlowLM on Ubuntu, replay the Linux preparation request through the desktop relay with the PCI instance, scoped changes and exact package pins. The Rust relay fixture covers the handoff. Live desktop elevation and activation on Ubuntu belong to the preparation UI and qualification tasks.

## FastFlowLM prepared operation, chat and maintenance

With the two staging binaries and the same Qwen3 fixture, dismiss and reopen preparation before and after consent. Cancel before a launcher claims the step and check that a new operation can start. Once claimed, reconnect without starting a second installer. Verify the displayed identity after activation. After installation, send a streaming request, stop it, send an ordinary request, then replace and remove the variant. Restart the owner while the maintenance guard is held and verify that the model cannot be loaded until installer recovery completes. Record Windows and Linux outcomes separately.
