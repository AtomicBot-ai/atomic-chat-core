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
 * lower-cased and renamed.
 */
function fromHfQuantConfig(hfQuantConfigJson: JsonObject): string | undefined {
  const quantization = asObject(hfQuantConfigJson.quantization)
  const quantAlgo = quantization === undefined ? undefined : asNonEmptyString(quantization.quant_algo)
  return quantAlgo === undefined ? undefined : renameFp8PbWo(quantAlgo)
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
 */
export function quantizationFormat(
  configJson: JsonObject,
  hfQuantConfigJson: JsonObject | null
): string | null {
  if (hfQuantConfigJson !== null) {
    const fromHf = fromHfQuantConfig(hfQuantConfigJson)
    if (fromHf !== undefined) return fromHf
  }
  const fromConfig = fromConfigQuantizationConfig(configJson)
  if (fromConfig !== undefined) return fromConfig
  return fromDtype(configJson)
}
