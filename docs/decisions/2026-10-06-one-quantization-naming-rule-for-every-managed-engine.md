---
date: 2026-10-06
title: "One quantization naming rule for every managed engine; a name is the encoding on disk"
---

# 2026-10-06 — One quantization naming rule for every managed engine; a name is the encoding on disk

- **Context:** the naming rule in conf's README was TensorRT-LLM's: AutoAWQ, GPTQ, compressed-tensors and Hugging Face FP8 without blocks were simply "not loadable". vLLM loads them, and a model in the Hub must have one format, whichever engine is asked.
- **Decision:** one rule (`src/runtime/managed-models/quant-format.ts`, mirroring conf's README) names the encoding of the weights on disk, not their arithmetic: `autoawq_w4a16` (4-bit, `gemm`), `gptq_w4a16`/`gptq_w8a16` (symmetric, plain `gptq` format), `hf_fp8` (no block size), `ct_w4a16`/`ct_w8a16`/`ct_w8a8_fp8`/`ct_w8a8_int8`/`ct_nvfp4` (every compressed-tensors group one scheme, no sparsity); ModelOpt names and `fp8_block_scales` are unchanged, bitsandbytes is not recognised. New names go only to checkpoints the rule did not recognise before, and no TensorRT-LLM descriptor has a row for them, so no TensorRT-LLM verdict changes; `trt-verdict-invariant.test.ts` holds the corpus of the TensorRT-LLM checks' checkpoints to the verdicts recorded before the rule changed, against `tensorrt-llm-1.3.0rc29-r3`. `quant_method` is lower-cased only for the methods the rule added: lower-casing `modelopt`/`fp8`/`mxfp4` too would name a checkpoint spelled `"FP8"` that was unrecognised and change its TensorRT-LLM verdict. The compatibility check is one skeleton for every engine with the engine's memory rule and checkpoint quirks as hooks.
- **Consequences:** an engine loads a format iff its own descriptor has a row for it; a refusal names the format and the engine. A future name may only be given to a checkpoint the rule does not recognise yet.
- **Owner:** `team`.
- **Links:** `src/runtime/managed-models/{quant-format,compatibility,check}.ts`, `src/runtime/tensorrt-llm/compatibility.ts`; conf README `runtimes/`; openspec change `add-vllm-runtime`, design D6, D7; ruling core 2.3.
