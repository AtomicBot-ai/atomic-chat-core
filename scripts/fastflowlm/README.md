# Build the FastFlowLM feasibility baseline

This builds the pinned upstream XRT server with the Atomic local-only patch. Use `flm atomic-capabilities --json` to inspect its identity and `flm serve <checkpoint> --atomic-local-only` to exercise it with explicit absolute `FLM_CONFIG_PATH`, `FLM_MODELINFO_PATH`, `FLM_MODEL_PATH` and `FLM_XCLBIN_PATH`. Only a patched release that passes the clean-host probe and the native offline tests is eligible for an Atomic engine manifest.

Start with a fresh checkout on the build machine. Run these commands from the Atomic core root and use a new destination outside it. Every build consumes its checkout by writing Cargo and CMake output.

```sh
git -c core.autocrlf=false clone --branch v1.0.11 --depth 1 --recurse-submodules --shallow-submodules https://github.com/ROCm/FastFlowLM.git ../flm-build-src
python3 scripts/fastflowlm/build.py --verify-only ../flm-build-src
```

On Linux, build the image from the recipe and mount only that disposable checkout read/write. The image uses the Ubuntu 24.04 userspace, GCC and development packages from the digest recorded by the successful upstream Noble job. Rust comes from the exact component archives and SHA-256 checksums in the lock. This container is a build tool. The installed engine runs directly on the host.

```sh
docker build --platform linux/amd64 -t atomic-flm-builder:1.0.11 scripts/fastflowlm
docker run --rm --platform linux/amd64 -v "$(realpath ../flm-build-src):/source" -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e 'GIT_CONFIG_VALUE_0=*' atomic-flm-builder:1.0.11 /source
```

On Windows, use the clean x64 VS 2026 runner image identified in the lock with its original vcpkg checkout and Rust toolchain. From PowerShell run `py -3 scripts/fastflowlm/build.py ../flm-build-src`. The build script invokes the pinned upstream setup script on this disposable builder, then the VS18 CMake preset. It checks the compiler after configuration. The Ubuntu and Windows executables are produced under `src/build` in the upstream checkout.

For the native feasibility test on an XDNA2 Windows machine, pass `--windows-feasibility` to the same command. This mode checks the installed Visual Studio build through `vswhere`. Install the x64 C++ tools and the Windows SDK recorded in the lock. Put Git, CMake, Rust and 7-Zip on PATH, set `VCPKG_INSTALLATION_ROOT` to the bootstrapped pinned vcpkg checkout and `RUNNER_TEMP` to a disposable scratch directory. Upstream stages build dependencies in `C:\dev`, which must be absent at the start.

If the upstream Opus mirrors fail during compilation, place the matching `opus-1.6.1.tar.gz` in the checkout's `src/build/ac/opus/dl/` after the failed build exits. Verify SHA-256 against `src/cmake/FlmAudioCodecs.cmake`, set `CARGO_NET_OFFLINE=true` in the same toolchain environment and rerun `cmake --build src/build --config Release --parallel 4` from the checkout. The CMake download step verifies the cached archive before extraction.

The lock identifies all Git submodules, the Git trees containing the upstream XRT engines, DLLs and xclbins, and the build scripts that pin the codec source archives, Windows Boost archive and XRT headers. The tokenizer's registry dependencies and their checksums are in `Cargo.lock`. Cargo prefetches that graph before the CMake compile with network access for Cargo disabled. To exercise source verification offline, run `python3 -m unittest discover -s scripts/fastflowlm`.

## Distribution boundary

Carry the three files below from the same upstream commit into each eventual archive. The Git object ids are in `provenance.json`.

- `LICENSE_RUNTIME.txt` covers the MIT runtime and server source.
- `LICENSE_BINARY.txt` covers the NPU kernel files and prebuilt engine libraries. Ship their unmodified bytes and this license. The build selects the XRT prebuilt engines and disables rebuilding Gemma4e.
- `THIRD_PARTY_NOTICES.txt` lists component-specific terms, including Windows runtime DLLs, XRT, tokenizers and codecs. Retain notices from any additional linked or staged components, including libwebp. Before publishing, compare staged binaries with the source inventory and review the actual dependency closure on each OS.

The Windows XRT import library is generated from the upstream export definitions. The driver supplies the actual DLL. On Linux the portable preset stages the XRT userspace libraries it finds. Verify the XDNA plugin and dependency closure in the **produced** archive before qualifying it. The host supplies the kernel driver and firmware.

## Exercise the patched executable

To run the standalone C++ policy regression against a checkout after applying the patch, use the commands below on Linux or macOS. They exercise model selection, path containment, missing and outdated files, and a kernel-directory link changed after readiness.

```sh
c++ -std=c++17 -I ../flm-build-src/src/include scripts/fastflowlm/local-only-test.cpp -o /tmp/flm-policy-test
/tmp/flm-policy-test "$(mktemp -d)"
```

Run `python3 scripts/fastflowlm/probe.py /absolute/path/to/flm` (or `py -3` and `flm.exe` on Windows). This first checks the executable's protocol without a ready device. It then supplies a missing explicit catalog beside a fallback catalog, a missing weight, and an outdated model. Each rejection must preserve every file. The test points proxies and fixture download origins at a counting loopback listener.

For the live tests, run the same command with `--catalog <one-model-list.json> --model-info <model-info.json> --model-base <installed-base> --checkpoint qwen3:0.6b` on the XDNA2 host with external egress disabled. The harness hashes the installed model tree before and after, waits for the selected checkpoint, checks the direct pull endpoint and changes the disposable catalog to reference a missing file or require a newer model. Each new chat request must return HTTP 409. The harness restores the catalog and asks for a short completion. Keep the OS network trace as well. The loopback counter observes attempts to use the configured sources and proxies. Record the platform, build pins, model hashes and observed network attempts with the result.

The XRT engines resolve model-specific kernels at `<FLM_XCLBIN_PATH>/xclbins/<model-directory-name>/`. The conf candidate places the kernel files beside the weights. The harness creates a directory link in the temporary session cache from that expected location to the installed variant (a junction on Windows, using Node). The local-only server checks that both paths resolve to the same directory. On a Krackan 1 NPU, the original Hugging Face kernel set timed out during inference. Keeping the same weights and replacing four kernels with those from the pinned FLM v1.0.11 tree produced an offline chat completion. The corrected installer plan pins those four files and their binary license from GitHub. The installed kernel paths and hashes identify the inputs used in each run.

## CI archives and pre-driver check

The FastFlowLM candidate workflow builds the two x64 archives from a fresh checkout and records their size and SHA-256. The Windows build installs the pinned VS18 toolchain on a VS17 runner. The Linux build stages the portable XRT installation from the pinned image. Both bundles include the upstream notices and libwebp's copyright and patent notices. The Linux archive contains regular files for both XRT lookup locations, including the XDNA plugin. The Windows driver supplies its XRT DLL.

Separate hosted VMs check for the absence of the AMD accelerator and system XRT, verify the archive digest, unpack into a temporary directory and run the capability and invalid-installation probes. After both probes pass, the `flm-qualified-candidate` Actions artifact contains the exact ZIP, tarball and a combined provenance document. It records the core SHA, dependency lock, patch SHA, archive hashes and actual XRT file inventory.

Release those same verified bytes under the version in the provenance document. The release operator enables GitHub release immutability before publishing an FLM prerelease, uploads all assets to the draft, then downloads the published assets by versioned URL and verifies the two hashes against the qualified CI artifact. GitHub Actions artifacts expire. Record the final release URLs and digest evidence in the change's acceptance report before closing 2.3.
