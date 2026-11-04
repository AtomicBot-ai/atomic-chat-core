---
date: 2026-11-04
title: "Keep CUDA runtime repair cancellable and coherent"
---

# 2026-11-04 — Keep CUDA runtime repair cancellable and coherent

- **Context:** Runtime delivery caught a cancelled download as an unavailable source and started the next download under the same task ID. Filling only missing DLL names could also combine an existing cuBLAS with another release's cuBLASLt, and a failed copy could be reported successful merely because all destination names existed.
- **Decision:** Preserve DOWNLOAD_CANCELLED as the terminal result in delivery and in the service that performs the initial provider repair. If the runtime is incomplete, copy its entire required DLL set from one source. Only a completed copy establishes success; directory entries after a copy error do not prove a usable runtime.
- **Consequences:** Cancelled installs do not restart through another source. Repairs can replace an existing DLL to keep the runtime coherent; a source that cannot supply the whole set is refused. Source ordering and checksum validation are unchanged. Invalid or overflowing model context windows retain the provider window instead of generating an Infinity or rounded token count.
- **Owner:** `team`.
- **Links:** PR #75, `src/backend/install/cuda-runtime-source.ts`, `src/backend/install/cuda-runtime-source.test.ts`.
