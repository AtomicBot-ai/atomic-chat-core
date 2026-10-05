---
date: 2026-10-05
title: "Use PrismML llama.cpp for desktop Bonsai"
---

# 2026-10-05 — Use PrismML llama.cpp for desktop Bonsai

- **Context:** Bonsai 2 and the Prism-private GGUF packings need runtime capabilities that cannot be assumed in the current upstream or TurboQuant provider. Earlier Bonsai files have different compatibility requirements. The user requested research and a complete implementation handoff, and agreed that PrismML llama.cpp on macOS is sufficient without adding a Bonsai MLX path.
- **Decision:** Plan a separate `atomic-prism` local provider using PrismML llama.cpp on desktop, including Metal on Apple Silicon and a validated CPU build on Intel Mac. Reuse the core's llama.cpp lifecycle, shared GGUF storage, downloads, hardware service, and GPU residency. Resolve compatibility per model artifact and approved engine release before selecting a provider/build. The app presents model-triggered engine onboarding using recommendations and operation state owned by the core.
- **Consequences:** A single GGUF/provider integration can cover supported macOS, Windows, and Linux hosts without a new MLX runtime or end-user Python/container setup. Engine packs/settings are isolated from other providers; weights remain shared. The plan reserves `<data>/atomic-prism/{backends,tmp}` and `<data>/atomic-core/prism-setups/`; implementation must add these paths and all new wire/model metadata to both repositories' contracts before use. Vendor binaries, device/driver combinations, and model files require pinned acceptance evidence. Ordinary upstream-compatible Bonsai files do not acquire an unconditional Prism requirement. Exact production pins and protocol compatibility are phase-0/phase-1 outputs. This record documents the implementation direction; no runtime support or performance validation is claimed by this documentation change.
- **Owner:** team.
- **Status:** implemented by [PrismML provider: a per-file compatibility gate and one recoverable model setup](2026-10-05-prismml-provider-compatibility-gate-and-model-setup.md); hardware acceptance is still pending, so every PrismML asset ships as `candidate`.
- **Links:** [Implementation plan](../prismml-bonsai-implementation-plan.md), [PrismML fork](https://github.com/PrismML-Eng/llama.cpp), [Bonsai demo](https://github.com/PrismML-Eng/Bonsai-demo), [Core-owned backend advice](2026-09-27-the-core-advises-on-backends-the-app-decides.md).
