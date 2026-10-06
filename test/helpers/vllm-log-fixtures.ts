/**
 * vLLM 0.31 container log lines and error answers for the `vllm` adapter's tests (change
 * `add-vllm-runtime`, task 3.2). **Constructed, not captured**: the decisive line of each — the
 * raised exception's message, the progress line, the error body — is vLLM's own wording as its
 * source raises or logs it (`vllm/v1/worker/gpu_worker.py` free-memory check, `vllm/v1/core/
 * kv_cache_utils.py` KV capacity check, `vllm/model_executor/models/registry.py` architecture
 * lookup, `vllm/entrypoints/openai/serving_engine.py` context-length validation, torch's CUDA
 * allocator for out-of-memory); timestamps, process prefixes and surrounding frames are
 * reconstructed. The live run of task 6.1 replaces them with captured logs.
 */

const prefix = (line: string) => `(EngineCore_DP0 pid=212) INFO 10-06 12:00:00 [core.py:71] ${line}`

/** A healthy start, in order: the lines the stage markers key on, then the server's own ready line. */
export const VLLM_START_LOG = [
  'INFO 10-06 12:00:00 [api_server.py:1880] vLLM API server version 0.31.0',
  prefix("Initializing a V1 LLM engine (v0.31.0) with config: model='/atomic/model', ..."),
  '(EngineCore_DP0 pid=212) INFO 10-06 12:00:03 [gpu_model_runner.py:2338] Starting to load model /atomic/model...',
  'Loading safetensors checkpoint shards:   0% Completed | 0/1 [00:00<?, ?it/s]',
  '(EngineCore_DP0 pid=212) INFO 10-06 12:00:09 [gpu_model_runner.py:2370] Model loading took 4.2117 GiB and 5.31 seconds',
  '(EngineCore_DP0 pid=212) INFO 10-06 12:00:12 [backends.py:548] Compiling a graph for dynamic shape takes 21.40 s',
  '(EngineCore_DP0 pid=212) INFO 10-06 12:00:31 [gpu_worker.py:298] Available KV cache memory: 1.50 GiB',
  '(EngineCore_DP0 pid=212) INFO 10-06 12:00:31 [kv_cache_utils.py:1087] GPU KV cache size: 49,152 tokens',
  'Capturing CUDA graphs (mixed prefill-decode, PIECEWISE): 100%|██████████| 11/11',
  '(EngineCore_DP0 pid=212) INFO 10-06 12:00:40 [gpu_model_runner.py:3480] Graph capturing finished in 8 secs, took 0.31 GiB',
  'INFO 10-06 12:00:41 [api_server.py:1971] Starting vLLM API server 0 on http://0.0.0.0:8000',
  'INFO:     Application startup complete.',
].join('\n')

/** torch's allocator while the weights load. */
export const VLLM_OOM_LOG = [
  '(EngineCore_DP0 pid=212) INFO 10-06 12:00:03 [gpu_model_runner.py:2338] Starting to load model /atomic/model...',
  '(EngineCore_DP0 pid=212) ERROR 10-06 12:00:07 [core.py:708] EngineCore failed to start.',
  'torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 1.17 GiB. GPU 0 has a total capacity of 7.63 GiB of which 512.00 MiB is free. Including non-PyTorch memory, this process has 6.95 GiB memory in use.',
  'RuntimeError: Engine core initialization failed. See root cause above. Failed core proc(s): {}',
].join('\n')

/** The start-up check vLLM V1 runs before profiling: less free memory than `--gpu-memory-utilization` asks for. */
export const VLLM_FREE_MEMORY_LOG = [
  '(EngineCore_DP0 pid=212) ERROR 10-06 12:00:02 [core.py:708] EngineCore failed to start.',
  'ValueError: Free memory on device (5.84/7.63 GiB) on startup is less than desired GPU memory utilization (0.9, 6.87 GiB). Decrease GPU memory utilization or reduce GPU memory used by other processes.',
].join('\n')

/** `max_model_len` larger than the KV cache holds. */
export const VLLM_KV_TOO_SMALL_LOG = [
  '(EngineCore_DP0 pid=212) INFO 10-06 12:00:31 [gpu_worker.py:298] Available KV cache memory: 0.25 GiB',
  '(EngineCore_DP0 pid=212) ERROR 10-06 12:00:31 [core.py:708] EngineCore failed to start.',
  "ValueError: To serve at least one request with the models's max seq len (32768), (3.00 GiB KV cache is needed, which is larger than the available KV cache memory (0.25 GiB). Based on the available memory, the estimated maximum model length is 2720. Try increasing `gpu_memory_utilization` or decreasing `max_model_len` when initializing the engine.",
].join('\n')

/** An architecture the image's vLLM has no implementation of. */
export const VLLM_UNSUPPORTED_ARCHITECTURE_LOG = [
  "ValueError: Model architectures ['FancyNewForCausalLM'] are not supported for now. Supported architectures: dict_keys(['AquilaModel', 'LlamaForCausalLM'])",
].join('\n')

/** Something else entirely. */
export const VLLM_OTHER_LOG = [
  'OSError: /atomic/model does not appear to have a file named tokenizer_config.json.',
].join('\n')

/** The 400 bodies of a request over the context (`serving_engine.py`), old and current wording. */
export const VLLM_CONTEXT_OVERFLOW_BODIES = {
  inputs:
    '{"object":"error","message":"This model\'s maximum context length is 8192 tokens. However, your request has 9000 input tokens. Please reduce the length of the input messages.","type":"BadRequestError","param":null,"code":400}',
  total:
    '{"error":{"message":"This model\'s maximum context length is 8192 tokens. However, you requested 9100 tokens (8100 in the messages, 1000 in the completion). Please reduce the length of the messages or completion.","type":"BadRequestError","param":null,"code":400}}',
  maxTokens:
    '{"error":{"message":"\'max_tokens\' or \'max_completion_tokens\' is too large: 4096. This model\'s maximum context length is 8192 tokens and your request has 5000 input tokens (4096 > 8192 - 5000).","type":"BadRequestError","param":null,"code":400}}',
}
