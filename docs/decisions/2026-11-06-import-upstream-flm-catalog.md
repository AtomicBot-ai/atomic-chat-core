---
date: 2026-11-06
title: "Import the shipped FastFlowLM chat catalog with editorial recommendations"
---

# Import the shipped FastFlowLM chat catalog

- **Context:** FLM exposed only the hardware-qualified Qwen3 0.6B entry, despite the shipped runtime supporting a larger upstream catalog. The operator requested the full catalog and then ten recommendations.
- **Decision:** conf owns the 44 XDNA2 chat checkpoints from the runtime's pinned upstream commit. Every download uses immutable source revisions, file sizes and SHA-256 hashes; source-commit kernels override Hub copies. Core embeds the matching native launch profiles without remote download fields. `qualification.status: upstream` records source provenance, distinct from `qualified` hardware evidence and staging-only `candidate`. An optional boolean `recommended` is editorial metadata, independent of qualification; the runtime descriptor excludes it. atc lists all entries, orders recommendations first and labels them in TUI/admin summaries.
- **Selection:** Qwen3 0.6B, 4B and 8B; Qwen3.5 0.8B, 2B and 4B; LFM3 1.7B; Llama3.2 3B; Gemma3 4B; Gemma4 E2B IT. This is a size/family selection, not a measured quality ranking. Qwen3 0.6B retains the existing hardware qualification and context limit.
- **Consequences:** The catalog remains complete for the existing XDNA2 chat adapter. Other NPU platforms, standalone embeddings, decision models and transcription need their own runtime routes and are excluded. Upstream vision/audio labels do not enable unsupported atc endpoints. All 44 file plans are validated without downloading model weights. New entries have not received hardware acceptance; existing runtime compatibility checks remain authoritative. Older FLM-aware core versions reject the new upstream qualification state, so deploy the updated core alongside this catalog. Legacy catalog projections are unchanged.
- **Owner:** team.
- **Links:** `atomic-chat-conf/.github/scripts/import-fastflowlm.py`; `atomic-chat-conf/models/catalog.json`; https://github.com/ROCm/FastFlowLM/blob/f37cdd29edc777cf3db1e385da8e7bfadc57d0b3/src/model_list.json
