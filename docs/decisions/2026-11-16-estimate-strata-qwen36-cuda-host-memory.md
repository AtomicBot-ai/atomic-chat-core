---
date: 2026-11-16
title: "Estimate host memory for the Strata Qwen3.6 CUDA Q4 profile"
---

# 2026-11-16 — Estimate host memory for the Strata Qwen3.6 CUDA Q4 profile

- **Context:** The setup recommendation of 32 GiB excluded an MSI laptop with 32 GiB installed and 31.42 GiB visible to Windows. The CUDA engine log for UD-Q4_K_XL showed a host expert arena of about 18.75 GiB. The hybrid engine can keep that arena alongside its GPU expert cache.
- **Decision:** Use 31 GiB for the pinned CUDA Q4 recipe, rounding the measured arena plus a 12 GiB allowance for the runtime and OS up to the next GiB. Keep separate checks for system RAM and VRAM and report which resource fell short.
- **Consequences:** The model catalog permits preparation on the measured MSI hardware. The estimate is a planning threshold. The engine's startup and live allocations determine whether the model runs.
- **Owner:** team.
