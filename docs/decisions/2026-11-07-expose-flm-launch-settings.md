---
date: 2026-11-07
title: "Expose typed FastFlowLM launch settings through the core"
---

# 2026-11-07 — Expose typed FastFlowLM launch settings through the core

- **Context:** FastFlowLM exposed only context and load timeout through the core. Its pinned 1.0.11 runtime also accepts NPU power, prefill chunk and prefix-cache controls. Clients must not construct native engine arguments themselves.
- **Decision:** Add `pmode`, `prefill_chunk_len`, `prefix_cache_mb`, `prefix_slots` and `prefix_min_gain` to the core's setting descriptors and canonical types. Validate them, including per-load overrides, at the launch boundary and build argv without a shell. Preserve upstream defaults (performance, model-specific prefill, 4096 MiB, 8 slots, 128-token gain). Zero slots disables caching; zero prefill omits the override. Sampling remains request-scoped.
- **Consequences:** Atc's schema-driven web and terminal forms use the same fields. Changes apply on the next model load. Context and explicit prefill round up to powers of two, with a minimum of 512. Context is capped to the largest power of two within the model metadata limit, so native rounding cannot exceed that limit and the route policy reports the normalized value. Prefix caching remains model-dependent; its memory setting is a ceiling, not a reservation. This change does not qualify new settings on physical hardware or change the runtime version.
- **Owner:** team.
- **Links:** `src/runtime/fastflowlm/launch-settings.ts`, `src/settings/schema/fastflowlm.json`; [pinned upstream CLI documentation](https://github.com/ROCm/FastFlowLM/blob/f37cdd29edc777cf3db1e385da8e7bfadc57d0b3/docs/docs/instructions/cli.md).
