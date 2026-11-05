---
date: 2026-11-05
title: "List llama.cpp devices from the pack a load runs on"
---

# 2026-11-05 — List llama.cpp devices from the pack a load runs on

- **Context:** Atomic-Chat#350: on Windows with an RX 7900 XTX and both the Vulkan and the ROCm b11463
  packs installed, the Hardware page said the selected backend "did not return a device list" whichever
  pack was selected. `GET /hardware/devices` ran `--list-devices` on `selectInstalledBackend`, the installed
  pack ranked best for the hardware facts, not on the configured `version_backend` that loads run. A gfx1100
  card ranks ROCm above Vulkan, so the page always showed the ROCm pack's answer; GPU facts without
  `vulkan_info`, or with under 2 GiB of VRAM, rank the CPU pack first or leave no compatible pack at all,
  and the page then shows an empty list without running the selected build. The app's device switches
  write the `device` setting that loads pass to the configured build, so the list they offer must come
  from that build. The extension this replaced listed the configured `version_backend`.
- **Decision:** The route resolves the pack the way a load does: `readRuntimeSettings` (the configured
  pack, or the discovered one when none is configured), then `ensureBackend` (the configured pack while it
  is installed and not recorded as failed on this machine, else the best installed one), with the CUDA
  guard's facts. The CUDA runtime repair a load runs is not run for a listing. A provider without a
  llama.cpp runtime, or no installed pack, still answers an empty list.
- **Consequences:** The Hardware page and the device switches describe the build models load on; switching
  packs changes the list. It does not explain or change where a model is placed: llama.cpp enumerates its
  own devices at load and fits layers itself, and a list that is still empty for the selected pack means
  that build cannot see the GPU. A failed `--list-devices` (timeout, missing header) still reaches the app
  as an error, which the extension shows as the same empty-list message.
- **Owner:** team.
- **Links:** <https://github.com/AtomicBot-ai/Atomic-Chat/issues/350>; `src/core/create.ts`
  (`models.devices`); `src/core/create.test.ts`; `src/backend/install/runtime-backend.ts`
  (`readRuntimeSettings`, `ensureBackend`, `selectInstalledBackend`).
