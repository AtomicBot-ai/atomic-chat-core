---
date: 2026-11-12
title: "Publish Qwen3.5 tool token IDs before Foundry loads the model"
---

# 2026-11-12 — Publish Qwen3.5 tool token IDs before Foundry loads the model

- **Context:** Foundry Local 2.4 requires published boundary token IDs for automatic tool calls. Microsoft's Qwen3.5-9B packages list the markers in the catalog and tokenizer, while their GenAI configs omit the IDs. Atomic Chat's local catalog has the capability flag, and GenAI 0.19 has no Qwen3.5 tokenizer fallback.
- **Decision:** Before registration on Foundry 2.4 and later, the host fills missing tool and configured reasoning boundary IDs for tool-enabled Qwen3.5 packages from their own added tokens. It updates the GenAI config atomically. Catalog marker strings alone would leave the automatic tool grammar without token IDs.
- **Consequences:** The next load can repair an existing installation. Models with complete boundary metadata retain their config. If the repair cannot write the file, the host reports the error and still attempts to load the model for ordinary chat.
- **Verification:** On macOS ARM64, Foundry 2.4.0 returned an automatic streaming tool call and accepted its result on the Microsoft Qwen3.5-9B CPU revision 3. The same native round trip passed on a Qwen3.5-0.8B CPU test copy. The repaired 0.8B config also loaded on Foundry 2.1.0. Windows execution is pending.
- **Owner:** team.
- **Links:** [Foundry Local 2.4.0](https://github.com/microsoft/foundry-local/releases/tag/v2.4.0), [GenAI 0.19 fallback implementation](https://github.com/microsoft/onnxruntime-genai/blob/v0.19.0/src/models/preprocessing/tokenizer_tag_utils.cpp).
