/**
 * SGLang v0.5.21 container log lines and error answers for the `sglang` adapter's tests (change
 * `add-sglang-runtime`, task 2.2). **Constructed, not captured**: the decisive line of each — the
 * raised exception's message, the progress line, the error body — is SGLang's own wording as its
 * source (commit `e00930c5`, the `v0.5.21` image's `ai.sglang.build.commit`) raises or logs it:
 * `model_executor/model_runner.py` (weights), `mem_cache/kv_cache_configurator.py` (the KV budget
 * check, `Memory pool end`), `model_executor/pool_configurator.py` (a pool of no tokens),
 * `model_executor/model_runner_components/cuda_graph_setup.py` (graph capture),
 * `managers/scheduler.py` (the pool summary), `entrypoints/http_server.py` (the ready line),
 * `models/registry.py` (architecture lookup), `managers/tokenizer_manager.py` (context-length
 * validation, answered by `entrypoints/openai/serving_base.py` as a 400) and torch's CUDA allocator
 * for out-of-memory. Timestamps and process prefixes are reconstructed. The live run of task 4.1
 * replaces them with captured logs.
 */

const at = (line: string) => `[2026-10-13 12:00:00] ${line}`

/** A healthy start, in order: the lines the stage markers key on, then the server's own ready line. */
export const SGLANG_START_LOG = [
  at('server_args=ServerArgs(model_path=/atomic/model, ...)'),
  at('Load weight begin. avail mem=6.71 GB'),
  'Loading safetensors checkpoint shards: 100% Completed | 1/1 [00:02<00:00,  2.31s/it]',
  at(
    'Load weight end. elapsed=3.12 s, type=Qwen3_5ForConditionalGeneration, avail mem=2.38 GB, mem usage=4.33 GB.'
  ),
  at('KV Cache is allocated. dtype: torch.bfloat16, #tokens: 61440, K size: 0.23 GB, V size: 0.23 GB'),
  at('Memory pool end. avail mem=1.86 GB'),
  at('Capture decode cuda graph begin. backend=full, num_tokens_per_req=1, bs=[1], avail mem=1.80 GB'),
  at('Capture decode cuda graph end. elapsed=4.10 s, mem usage=0.05 GB. avail mem=1.75 GB.'),
  at(
    'max_total_num_tokens=61440, chunked_prefill_size=2048, max_prefill_tokens=16384, max_running_requests=1, context_len=8192, available_gpu_mem=1.75 GB'
  ),
  'INFO:     Uvicorn running on http://0.0.0.0:30000 (Press CTRL+C to quit)',
  at('The server is fired up and ready to roll!'),
].join('\n')

/** torch's allocator while the weights load. */
export const SGLANG_OOM_LOG = [
  at('Load weight begin. avail mem=6.71 GB'),
  'torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 1.17 GiB. GPU 0 has a total capacity of 7.63 GiB of which 512.00 MiB is free. Including non-PyTorch memory, this process has 6.95 GiB memory in use.',
  at('Received sigquit from a child process. It usually means the child failed.'),
].join('\n')

/** The KV budget check (`_profile_available_bytes`): the weights took the whole static share. */
export const SGLANG_NO_KV_MEMORY_LOG = [
  at('Load weight end. elapsed=3.12 s, type=Qwen3ForCausalLM, avail mem=0.61 GB, mem usage=6.10 GB.'),
  'ValueError: Loaded weights leave no GPU memory for the KV cache under --mem-fraction-static=0.75. Raise --mem-fraction-static above 0.812 (minimum viable = 1 - available/pre = 0.8115). If using speculative decoding, draft weights are now counted.',
].join('\n')

/** A KV pool of zero tokens (`MemoryPoolConfig.__post_init__`). */
export const SGLANG_NOT_ENOUGH_MEMORY_LOG = [
  at('Load weight end. elapsed=3.12 s, type=Qwen3ForCausalLM, avail mem=1.02 GB, mem usage=5.70 GB.'),
  'RuntimeError: Not enough memory. Please try to increase --mem-fraction-static. Current value: mem_fraction_static=0.7',
].join('\n')

/** An architecture the image's SGLang has no class for. */
export const SGLANG_UNSUPPORTED_ARCHITECTURE_LOG = [
  "ValueError: Model architectures ['FancyNewForCausalLM'] are not supported for now. Supported architectures: dict_keys(['LlamaForCausalLM', 'Qwen3ForCausalLM'])",
].join('\n')

/** Something else entirely. */
export const SGLANG_OTHER_LOG = [
  'OSError: /atomic/model does not appear to have a file named tokenizer_config.json.',
].join('\n')

/** The 400 bodies of a request over the context: the input alone, and the input with its `max_tokens`. */
export const SGLANG_CONTEXT_OVERFLOW_BODIES = {
  input:
    '{"object":"error","message":"The input (9000 tokens) is longer than the model\'s context length (8192 tokens).","type":"BadRequestError","param":null,"code":400}',
  total:
    '{"object":"error","message":"Requested token count exceeds the model\'s maximum context length of 8192 tokens. You requested a total of 9100 tokens: 8100 tokens from the input messages and 1000 tokens for the completion. Please reduce the number of tokens in the input messages or the completion to fit within the limit.","type":"BadRequestError","param":null,"code":400}',
}
