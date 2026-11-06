---
date: 2026-11-05
title: "Pin FastFlowLM build inputs before changing the server"
---

# 2026-11-05 — Pin FastFlowLM build inputs before changing the server

- **Context:** Atomic installs model files through the client. Upstream FastFlowLM v1.0.11 may pull files while serving requests. The feasibility test must identify exactly which executable and engine binaries it exercised.
- **Decision:** Build the upstream XRT configuration from commit `f37cdd29edc777cf3db1e385da8e7bfadc57d0b3`. Pin both native toolchains, recursive submodules and the tokenizer's Cargo graph. Limit the planned patch to the open runtime, its CLI, server and build rules. Ship upstream prebuilt engines and kernels byte for byte with their notices.
- **Consequences:** New dependencies or compiler versions require a new reviewed lock. On Windows the upstream executable imports the driver's `xrt_coreutil.dll` at load time, including through model DLLs. A capability check in upstream `main` alone cannot run before the driver is installed. A clean-host probe and offline inference remain separate acceptance checks.
- **Owner:** team
- **Links:** [Build inputs](../../scripts/fastflowlm/provenance.json), [upstream binary license](https://github.com/ROCm/FastFlowLM/blob/f37cdd29edc777cf3db1e385da8e7bfadc57d0b3/LICENSE_BINARY.txt).
