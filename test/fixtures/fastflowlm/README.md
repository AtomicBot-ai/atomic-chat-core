# FastFlowLM control fixtures

The model candidate is the Qwen3 staging entry from atomic-chat-conf commit `01b781e679bfd40eb70bc75df5fbab05f4e62504`. The installed-model tests materialize small synthetic files with their own matching hashes.

`control-v1.json` specifies examples for D5, D7 and D8 of `add-fastflowlm-runtime` in atomic-chat-spec commit `f3e1fd75620e2233aa2a21f49efa72ffb0566ff3`. It is fixture revision 1 for control protocol 2. The Linux step uses the pinned noble DKMS package identity and an example qualification document, kernel and runtime account. The relay echoes the digests computed from that request. Model check and engine versions run against a real core with an injected Linux host, isolated data folder and local release manifest. For preparation and maintenance the fixture supplies responses to the SDK until their producers land. Compare stable fields and enum values as JSON; reasons are diagnostics. Ordering of object properties, generated IDs and absolute filesystem paths are incidental.

`relay-event.json` was emitted by a Rust test linked to the desktop relay, `src-tauri/src/core/atomic_core/relay.rs` (app checkout `250aa30ae6aebbcea1432eacd7d026a010c0b286`). The test uses the app's SSE parser, payload decoder and event prefix. It also calls the app's host-step reader and receipt builder on the decoded snapshot. This tests the handoff without requesting elevation. The core contract test feeds the matching event through its SSE encoder and public client, then compares the full payload with the recovery response. To regenerate from the core root after building the matching app library in its default debug profile:

```sh
deps=../Atomic-Chat/src-tauri/target/debug/deps
rustc --edition=2021 --test test/fixtures/fastflowlm/emit-relay.rs \
  -L dependency="$deps" --extern app_lib="$deps/libapp_lib.rlib" -o /tmp/flm-emit-relay
/tmp/flm-emit-relay
```


The Windows accelerator fixture is also replayed against the authenticated owner with a simulated present PCI device and missing driver. `windows-xrt-pci.json` records the identity fields read from one XRT handle on the Windows 11 XDNA2 host with driver 32.0.203.329. The same handle reports a differently formatted BDF from PnP. The regression requires all five PCI identity fields and rejects a different subsystem device.
