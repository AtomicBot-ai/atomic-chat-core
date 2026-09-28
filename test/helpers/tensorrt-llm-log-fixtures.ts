/**
 * Container log tails for the `tensorrt-llm` adapter's `classifyExit` (task 2.13,
 * `test/fixtures/tensorrt-llm/logs/`).
 *
 * Labelled honestly (review round 1, `findings-2.13-r1.md` item 5; wording sharpened in round 2,
 * `findings-2.13-r2.md` item 9): these are **constructed** tracebacks, not captured console
 * transcripts — no full verbatim `trtllm-serve` 1.2.1 session log was available to copy from. Two
 * different levels of confidence sit side by side in each file, and neither should be mistaken for
 * the other:
 * - **Real, verified against the pinned tag's source** (`src/runtime/tensorrt-llm/adapter.ts`'s file
 *   header has the full citations, including exact line numbers where cited below): the raised
 *   exception's own message text on each traceback's final line, and the *module path* each frame
 *   names (`_torch/pyexecutor/weight_loader.py`, `_torch/pyexecutor/resource_manager.py`,
 *   `_torch/pyexecutor/py_executor_creator.py`, `_torch/models/modeling_auto.py`,
 *   `_torch/modules/linear.py` — all real files in the pinned tag that do contain the code in
 *   question).
 * - **Reconstructed, not verified line by line**: every other detail — the specific line number
 *   shown for each traceback frame (except where a line number is called out explicitly below, e.g.
 *   `linear.py:2066`), the function name and body text of intermediate frames, timestamps, and
 *   progress-bar percentages. These make the fixture read like a plausible console capture; they are
 *   not claims about the exact source line a real run would print.
 * - `oom-weight-load.log` / `oom-kv-cache-estimation.log` / `oom-small-allocation-kib.log`:
 *   `torch`'s own CUDA allocator wording (`CUDA out of memory. Tried to allocate ... of which ...
 *   is free`, unrelated to any TensorRT-LLM release), quoted from real `trtllm-serve` crash reports
 *   in NVIDIA/TensorRT-LLM issues #7818 (mid-size, `MiB`) and #8642 (`0 bytes` free, the KV-cache
 *   sizing case); `oom-small-allocation-kib.log` uses `KiB` in both positions to exercise that unit.
 * - `oom-cpp-runtime.log`: the executor's own C++-side allocator failure
 *   (`py_executor_creator.py`'s `_maybe_explain_if_oom` treats any exception whose text contains
 *   `"out of memory"` as OOM, independent of `torch`'s own wording) — no "Tried to allocate ...
 *   free" numbers are attached, since that phrasing belongs to `torch`'s allocator, not a raw CUDA
 *   runtime call failure.
 * - `unsupported-architecture.log`: `_torch/models/modeling_auto.py`'s
 *   `AutoModelForCausalLM.from_config`, the pytorch backend's actual model-class lookup —
 *   `"Unknown architecture for AutoModelForCausalLM: {arch}"`.
 * - `unsupported-quantization.log`: `_torch/modules/linear.py`'s real raise,
 *   `"unsupported quant mode: {quant_mode}"` (line 2066).
 * - `other-startup-crash.log`: an unrelated startup failure, for the `other` classification.
 *
 * None of this touches the network — the files are checked in.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function readTensorrtLlmLogFixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../fixtures/tensorrt-llm/logs/${name}`, import.meta.url)),
    'utf8'
  )
}
