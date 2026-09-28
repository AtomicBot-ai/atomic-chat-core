/**
 * Container log tails for the `tensorrt-llm` adapter's `classifyExit` (task 2.13,
 * `test/fixtures/tensorrt-llm/logs/`): realistic `trtllm-serve` 1.2.1 tracebacks, sourced from the
 * verbatim error text NVIDIA/TensorRT-LLM raises in each situation — an out-of-memory allocation
 * during weight loading and during KV-cache sizing (`torch.OutOfMemoryError`/`RuntimeError: CUDA
 * out of memory. Tried to allocate ... of which ... is free`, seen in NVIDIA/TensorRT-LLM issues
 * #7818 and #8642), an unsupported architecture (`tensorrt_llm/models/automodel.py`'s
 * `TopModelMixin.from_hugging_face`: "The given huggingface model architecture {X} is not
 * supported in TRT-LLM yet", NVIDIA/TensorRT-LLM issue #2845), and an unrelated startup crash for
 * the `other` classification. None of this touches the network — the files are checked in.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function readTensorrtLlmLogFixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../fixtures/tensorrt-llm/logs/${name}`, import.meta.url)),
    'utf8'
  )
}
