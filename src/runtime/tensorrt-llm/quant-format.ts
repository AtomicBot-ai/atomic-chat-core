/**
 * The quantization-format naming rule: a fixed checkpoint-metadata → format-name mapping that
 * `RuntimeDescriptor.quantization[].format` (`src/contracts/environment.ts`) is keyed by. Ported
 * verbatim from `atomic-chat-conf`'s README, "Runtime descriptors (`runtimes/`)" →
 * `quantization[].format` names — this file *is* the core side of that conf↔core contract, so any
 * change to the rule has to change both places together.
 *
 * The inputs are a checkpoint's `config.json` and, when the repository carries the file, its
 * `hf_quant_config.json`. A checkpoint can be quantized with no `quantization_config` in
 * `config.json` at all (e.g. `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-FP8`,
 * `nvidia/Llama-3.3-70B-Instruct-NVFP4`), so `hf_quant_config.json` must always be checked before
 * `dtype`/`torch_dtype` is trusted. Steps apply in order, stopping at the first that matches; `null`
 * means the naming rule does not recognise the checkpoint (an unsupported `quant_method` such as
 * `awq`/`gptq`, an `fp8` checkpoint without the block size this engine loads, or a `dtype` other
 * than `bfloat16`/`float16`) — the caller rejects that as an unsupported format, never guesses.
 *
 * Pure and network-free, like every file in this module (design D12).
 */

/** A parsed JSON object, exactly as `config.json` / `hf_quant_config.json` arrive on the wire. */
export type JsonObject = Record<string, unknown>

const FP8_PB_WO = 'fp8_pb_wo'
const FP8_BLOCK_SCALES = 'fp8_block_scales'

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** `fp8_pb_wo` is what NVIDIA ModelOpt calls it; the engine itself calls the same format `fp8_block_scales`. */
function renameFp8PbWo(quantAlgo: string): string {
  const lower = quantAlgo.toLowerCase()
  return lower === FP8_PB_WO ? FP8_BLOCK_SCALES : lower
}

/**
 * Every sibling that is a `.gguf` file. GGUF is not a case of the naming rule at all — this engine
 * never loads a GGUF checkpoint's `config.json` — it is the separate, always-reject gate
 * `compatibility.ts` applies before the naming rule runs at all (spec `tensorrt-llm-models`: "for
 * GGUF there is llama.cpp"). A listing with even one `.gguf` file counts, which also covers a
 * GGUF-only listing.
 */
export function isGgufCheckpoint(files: readonly { path: string }[]): boolean {
  return files.some((file) => file.path.toLowerCase().endsWith('.gguf'))
}

/**
 * Step 1: `hf_quant_config.json` present (NVIDIA ModelOpt) → its `quantization.quant_algo`,
 * lower-cased and renamed. The README rule stops here whenever the file is present at all — a
 * present-but-empty/missing `quant_algo` (e.g. a ModelOpt KV-cache-only export) is `null`
 * (unrecognised), never a reason to fall through to `config.json`/`dtype`.
 */
function fromHfQuantConfig(hfQuantConfigJson: JsonObject): string | null {
  const quantization = asObject(hfQuantConfigJson.quantization)
  const quantAlgo = quantization === undefined ? undefined : asNonEmptyString(quantization.quant_algo)
  return quantAlgo === undefined ? null : renameFp8PbWo(quantAlgo)
}

/**
 * Step 2: `config.json`'s `quantization_config.quant_method`. Returns `null` (recognised as *not
 * loadable*, distinct from `undefined` meaning "step 2 does not apply") for every `quant_method`
 * this engine release cannot load, so the caller never falls through to reading `dtype` for a
 * checkpoint that step 2 already identified as quantized.
 */
function fromConfigQuantizationConfig(configJson: JsonObject): string | null | undefined {
  const quantizationConfig = asObject(configJson.quantization_config)
  if (quantizationConfig === undefined) return undefined
  const quantMethod = quantizationConfig.quant_method
  if (quantMethod === 'modelopt') {
    const quantAlgo = asNonEmptyString(quantizationConfig.quant_algo)
    return quantAlgo === undefined ? null : renameFp8PbWo(quantAlgo)
  }
  if (quantMethod === 'fp8') {
    const blockSize = quantizationConfig.weight_block_size
    const isFp8BlockScales =
      Array.isArray(blockSize) && blockSize.length === 2 && blockSize[0] === 128 && blockSize[1] === 128
    // `fp8` without that exact block size is not loadable by this engine release
    // (`model_config.py:323`) and must not fall through to step 3 as `bf16`/`fp16`.
    return isFp8BlockScales ? FP8_BLOCK_SCALES : null
  }
  if (quantMethod === 'mxfp4') return 'mxfp4'
  // awq, gptq, anything else: not loadable by this engine release.
  return null
}

/** Step 3: unquantized. `dtype` is what TensorRT-LLM itself reads; `torch_dtype` is the legacy fallback. */
function fromDtype(configJson: JsonObject): string | null {
  const dtype = asNonEmptyString(configJson.dtype) ?? asNonEmptyString(configJson.torch_dtype)
  if (dtype === 'bfloat16') return 'bf16'
  if (dtype === 'float16') return 'fp16'
  return null
}

/**
 * The naming rule, applied in order. `null` means unrecognised: the caller must reject it as an
 * unsupported format rather than reporting `bf16`/`fp16` by default.
 *
 * `hf_quant_config.json` being present at all stops the rule at step 1 — its own `null` (an
 * unrecognised or missing `quant_algo`) is final and never falls through to `config.json`/`dtype`,
 * matching the README: "if hf_quant_config.json is present ... the format is its quant_algo".
 */
export function quantizationFormat(
  configJson: JsonObject,
  hfQuantConfigJson: JsonObject | null
): string | null {
  if (hfQuantConfigJson !== null) {
    return fromHfQuantConfig(hfQuantConfigJson)
  }
  const fromConfig = fromConfigQuantizationConfig(configJson)
  if (fromConfig !== undefined) return fromConfig
  return fromDtype(configJson)
}

/**
 * The KV-cache's own quantization algorithm — NVIDIA ModelOpt's `kv_cache_quant_algo`, a sibling
 * field to `quant_algo` above, read the same way and from the same object: `hf_quant_config.json`'s
 * `quantization` when the repository carries the file, else `config.json`'s `quantization_config`.
 * Used by the KV-cache memory formula (`compatibility.ts`, task 2.16w round 1) to size a KV cache
 * entry at 1 byte (`FP8`) instead of the engine's own default 2 bytes (`bf16`/`fp16`). `undefined`
 * when neither object carries it — an unquantized KV cache, or a checkpoint this naming rule does
 * not otherwise recognise.
 */
export function kvCacheQuantAlgo(
  configJson: JsonObject,
  hfQuantConfigJson: JsonObject | null
): string | undefined {
  if (hfQuantConfigJson !== null) {
    const quantization = asObject(hfQuantConfigJson.quantization)
    return quantization === undefined ? undefined : asNonEmptyString(quantization.kv_cache_quant_algo)
  }
  const quantizationConfig = asObject(configJson.quantization_config)
  return quantizationConfig === undefined
    ? undefined
    : asNonEmptyString(quantizationConfig.kv_cache_quant_algo)
}

/**
 * What the naming rule actually saw when it did not recognise a format, for error messages only —
 * never consulted to decide the format itself (that is `quantizationFormat`'s job alone). Mirrors
 * `quantizationFormat`'s own step order, so the two must be kept in sync.
 */
export function describeUnrecognizedQuantization(
  configJson: JsonObject,
  hfQuantConfigJson: JsonObject | null
): string {
  if (hfQuantConfigJson !== null) {
    const quantization = asObject(hfQuantConfigJson.quantization)
    const quantAlgo = quantization?.quant_algo
    return `hf_quant_config.json quantization.quant_algo=${JSON.stringify(quantAlgo ?? null)}`
  }
  const quantizationConfig = asObject(configJson.quantization_config)
  if (quantizationConfig !== undefined) {
    const quantMethod = quantizationConfig.quant_method
    if (quantMethod === 'modelopt') {
      return `config.json quantization_config.quant_method="modelopt" quant_algo=${JSON.stringify(quantizationConfig.quant_algo ?? null)}`
    }
    if (quantMethod === 'fp8') {
      return `config.json quantization_config.quant_method="fp8" weight_block_size=${JSON.stringify(quantizationConfig.weight_block_size ?? null)}`
    }
    return `config.json quantization_config.quant_method=${JSON.stringify(quantMethod ?? null)}`
  }
  const dtype = configJson.dtype ?? configJson.torch_dtype
  return `config.json dtype=${JSON.stringify(dtype ?? null)}`
}
