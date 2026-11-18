---
date: 2026-11-16
title: "Fit Strata Qwen3.6 Auto to CUDA memory"
---

# 2026-11-16 — Fit Strata Qwen3.6 Auto to CUDA memory

- **Context:** On the RTX 4070 Laptop (8188 MiB), Qwen3.6 UD-Q4_K_XL with 8192 tokens and vision left 4 MiB free before the engine requested 1159 MiB for its hybrid working buffers. A text-only launch at 4096 tokens worked.
- **Decision:** For this CUDA quant, Auto uses at most 4096 tokens and disables vision below 10 GiB of VRAM. Use the same effective settings and memory floor for compatibility checks and startup. Preserve explicit context and refuse a profile that exceeds the selected card's capacity before launching the engine. Strata claims its selected GPU exclusively, awaiting confirmed shutdown of any previous Strata model on that GPU before starting the next one.
- **Consequences:** The tested 8 GB card can load the quant for text chat on defaults. The 10 GiB floor for longer contexts and vision is a conservative estimate based on the failed allocation. The check uses total VRAM because Atomic Core can reclaim its own GPU sessions before starting the model. Unrelated GPU processes can still consume that budget.
- **Owner:** team.
