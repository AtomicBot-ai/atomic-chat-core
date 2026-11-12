---
date: 2026-11-12
title: "Repair Foundry tool boundaries from published markers"
---

# 2026-11-12 — Repair Foundry tool boundaries from published markers

- **Context:** Atomic Chat registered Foundry variants with the tool capability flag and discarded the published tool marker strings. The 2.4.0 native runtime needs distinct tokenizer IDs for automatic tool calling. The November 12 Microsoft catalog audit found absent IDs in 43 variants across 20 models, including Qwen3.5, Qwen3-VL, QNN Qwen and Phi, Gemma 4, Ministral, Mistral Nemo, Olmo and SmolLM3.
- **Decision:** Store Microsoft’s tool marker strings with each new download. On Foundry 2.4 and later, the host resolves both IDs from the package’s exact added tokens before registration. Installed revisions use their audited model-type markers. Ambiguous legacy markers, missing tokens and conflicting existing IDs do not trigger a rewrite.
- **Decision:** For Gemma 4, keep the published token IDs and make its tool and reasoning boundaries visible to ORT Extensions’ SentencePiece BPE decoder. Correct the catalog’s reasoning spellings using the actual template and tokens. The host also repairs the audited chat templates where Gemma 4 drops a canonical tool result, Mistral Nemo rejects Foundry’s own call ID, or SmolLM3 uses an unsupported Jinja method.
- **Consequences:** Existing downloads can be repaired offline on load. Config, template and tokenizer updates use atomic file replacement and are idempotent. The scope covers catalog packages with one-token boundaries. Models with a missing catalog contract for reasoning, such as Phi-4-mini-reasoning, need separate qualification.
- **Verification:** The production host repaired all 43 downloaded catalog configurations. The bundled GenAI 0.19 tokenizer then returned the expected boundary strings and IDs and rendered the canonical call followed by its result for every variant. Native Foundry 2.4.0 also completed the full streaming tool round trip on Qwen3.5-9B CPU revision 3 on macOS ARM64. This audit did not run generation on each accelerator.
- **Owner:** team.
- **Links:** [Foundry Local 2.4.0](https://github.com/microsoft/foundry-local/releases/tag/v2.4.0), [GenAI 0.19 tokenizer fallback](https://github.com/microsoft/onnxruntime-genai/blob/v0.19.0/src/models/preprocessing/tokenizer_tag_utils.cpp), [ORT Extensions decoder](https://github.com/microsoft/onnxruntime-extensions/blob/e2e119c08b4379d038bcb5c75d9111328a9b86c1/operators/tokenizer/bpe_streaming.hpp).
