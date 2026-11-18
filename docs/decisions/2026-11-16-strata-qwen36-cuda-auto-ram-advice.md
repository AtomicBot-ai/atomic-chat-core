---
date: 2026-11-16
title: "Treat the Strata CUDA Qwen3.6 Auto RAM estimate as launch advice"
---

# 2026-11-16 — Treat the Strata CUDA Qwen3.6 Auto RAM estimate as launch advice

- **Context:** The system RAM reservation estimates space for the model's host expert arena during inference. Qwen3.6 preparation only extracts tokenizer metadata from the pinned GGUF. The Windows Model Hub used the launch estimate to disable both acquisition and preparation.
- **Decision:** A system RAM shortfall for Qwen3.6 CUDA in Auto produces a launch warning. Keep checks for disk space, compatible builds, and VRAM. Explicit RAM mode still requires the estimated system RAM.
- **Consequences:** Users can prepare a supported model even when the Auto launch estimate predicts a RAM shortfall. The engine can still fail to allocate memory when the user starts the model.
- **Owner:** team.
