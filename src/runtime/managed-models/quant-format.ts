/**
 * The quantization-format naming rule: a fixed checkpoint-metadata → format-name mapping that
 * `RuntimeDescriptor.quantization[].format` (`src/contracts/environment.ts`) is keyed by. Ported
 * verbatim from `atomic-chat-conf`'s README, "Runtime descriptors (`runtimes/`)" →
 * `quantization[].format` names — this file *is* the core side of that conf↔core contract, so any
 * change to the rule has to change both places together. One rule for every managed engine (change
 * `add-vllm-runtime`, design D6): a name says how the weights are encoded on disk, and an engine
 * loads a format iff its own descriptor has a row for it. The names added for vLLM (`hf_fp8`,
 * `autoawq_w4a16`, `gptq_w4a16`/`gptq_w8a16`, the `ct_*` schemes) went only to checkpoints the rule
 * did not recognise before, so no TensorRT-LLM verdict changed (`trt-verdict-invariant.test.ts`).
 *
 * The inputs are a checkpoint's `config.json` and, when the repository carries the file, its
 * `hf_quant_config.json`. A checkpoint can be quantized with no `quantization_config` in
 * `config.json` at all (e.g. `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-FP8`,
 * `nvidia/Llama-3.3-70B-Instruct-NVFP4`), so `hf_quant_config.json` must always be checked before
 * `dtype`/`torch_dtype` is trusted. Steps apply in order, stopping at the first that matches; `null`
 * means the naming rule does not recognise the checkpoint (an unknown `quant_method` or
 * `bitsandbytes`, an AWQ/GPTQ packing outside the named ones, an `fp8` block size other than
 * 128×128, a compressed-tensors scheme outside the table, an MLX checkpoint's top-level
 * `quantization`, or a `dtype` other than `bfloat16`/`float16`) — every engine rejects that as an
 * unsupported format, never guesses.
 *
 * Pure and network-free, like every file in this module (design D12).
 */

/** A parsed JSON object, exactly as `config.json` / `hf_quant_config.json` arrive on the wire. */
export type JsonObject = Record<string, unknown>

const FP8_PB_WO = 'fp8_pb_wo'
const FP8_BLOCK_SCALES = 'fp8_block_scales'
/** Hugging Face / AutoFP8: `quant_method: fp8` with per-tensor or per-channel scales, no blocks. */
const HF_FP8 = 'hf_fp8'

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
 * nameable*, distinct from `undefined` meaning "step 2 does not apply") for every `quant_method` or
 * packing the rule does not name, so the caller never falls through to reading `dtype` for a
 * checkpoint that step 2 already identified as quantized.
 *
 * `modelopt`, `fp8` and `mxfp4` are matched exactly as before the shared rule; only the methods it
 * added (`awq`, `gptq`, `compressed-tensors`) are matched lower-cased. Lower-casing the old ones
 * too would name a checkpoint spelled `"FP8"` that was unrecognised until now, and so change a
 * TensorRT-LLM verdict (ruling core 2.3).
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
    if (blockSize === undefined || blockSize === null) return HF_FP8
    const isFp8BlockScales =
      Array.isArray(blockSize) && blockSize.length === 2 && blockSize[0] === 128 && blockSize[1] === 128
    // Any other block size is not recognised and must not fall through to `dtype` as `bf16`/`fp16`.
    return isFp8BlockScales ? FP8_BLOCK_SCALES : null
  }
  if (quantMethod === 'mxfp4') return 'mxfp4'
  const method = typeof quantMethod === 'string' ? quantMethod.toLowerCase() : undefined
  if (method === 'awq') return fromAutoAwq(quantizationConfig)
  if (method === 'gptq') return fromGptq(quantizationConfig)
  if (method === 'compressed-tensors') return fromCompressedTensors(quantizationConfig)
  // bitsandbytes (deliberately: engines load it slowly and only partially), anything else.
  return null
}

const lower = (value: unknown): string | undefined =>
  typeof value === 'string' ? value.toLowerCase() : undefined

/** AutoAWQ: 4 bits (`bits` or `w_bit`) and the `gemm` packing (or none named); other packings differ on disk. */
function fromAutoAwq(config: JsonObject): string | null {
  const bits = config.bits ?? config.w_bit
  const version = config.version
  const gemm = version === undefined || version === null || lower(version) === 'gemm'
  return bits === 4 && gemm ? 'autoawq_w4a16' : null
}

/** GPTQ: 4 or 8 bits, symmetric, the plain `gptq` checkpoint format (or none named). */
function fromGptq(config: JsonObject): string | null {
  const format = config.checkpoint_format
  const plain = format === undefined || format === null || lower(format) === 'gptq'
  if (config.sym !== true || !plain) return null
  if (config.bits === 4) return 'gptq_w4a16'
  if (config.bits === 8) return 'gptq_w8a16'
  return null
}

/** One compressed-tensors group's `weights` × `input_activations` against the scheme table. */
function compressedTensorsScheme(group: JsonObject): string | null {
  const weights = asObject(group.weights)
  if (weights === undefined) return null
  const activations = group.input_activations === null ? undefined : asObject(group.input_activations)
  if (group.input_activations !== undefined && group.input_activations !== null && activations === undefined)
    return null
  const type = lower(weights.type)
  const bits = weights.num_bits
  if (activations === undefined) {
    if (type === 'int' && bits === 4) return 'ct_w4a16'
    if (type === 'int' && bits === 8) return 'ct_w8a16'
    return null
  }
  const activationType = lower(activations.type)
  const activationBits = activations.num_bits
  if (type === 'float' && bits === 8 && activationType === 'float' && activationBits === 8)
    return 'ct_w8a8_fp8'
  if (type === 'int' && bits === 8 && activationType === 'int' && activationBits === 8) return 'ct_w8a8_int8'
  if (
    type === 'float' &&
    bits === 4 &&
    weights.group_size === 16 &&
    activationType === 'float' &&
    activationBits === 4
  )
    return 'ct_nvfp4'
  return null
}

/**
 * compressed-tensors (llm-compressor): every group must name the same scheme, and a sparsity config
 * other than none (`null`, `{}`) or `dense` makes the checkpoint unrecognised.
 */
function fromCompressedTensors(config: JsonObject): string | null {
  const sparsity = config.sparsity_config
  if (sparsity !== undefined && sparsity !== null) {
    const sparsityObject = asObject(sparsity)
    if (sparsityObject === undefined) return null
    if (Object.keys(sparsityObject).length > 0 && lower(sparsityObject.format) !== 'dense') return null
  }
  const groups = asObject(config.config_groups)
  if (groups === undefined) return null
  const names = new Set<string | null>()
  for (const group of Object.values(groups)) {
    const groupObject = asObject(group)
    names.add(groupObject === undefined ? null : compressedTensorsScheme(groupObject))
  }
  if (names.size !== 1) return null
  return [...names][0] ?? null
}

/**
 * The checkpoint's weight dtype: `dtype` is what TensorRT-LLM itself reads, `torch_dtype` is the
 * legacy fallback. A VLM-style config (Qwen3.5 and later) declares it only on `text_config`, which
 * TensorRT-LLM 1.3 falls back to as well (`model_config.py`), so this does too.
 */
function configDtype(configJson: JsonObject): unknown {
  const textConfig = asObject(configJson.text_config)
  return (
    asNonEmptyString(configJson.dtype) ??
    asNonEmptyString(configJson.torch_dtype) ??
    (textConfig === undefined
      ? undefined
      : (asNonEmptyString(textConfig.dtype) ?? asNonEmptyString(textConfig.torch_dtype)))
  )
}

/** Step 3: unquantized, named by `configDtype`. */
function fromDtype(configJson: JsonObject): string | null {
  const dtype = configDtype(configJson)
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
  // An MLX checkpoint names its quantization in a top-level `quantization` object (`bits`,
  // `group_size`) and keeps the unquantized model's `dtype`, so stepping on to `dtype` would call
  // its packed low-bit weights `bf16` and pass the check (prism-ml/Bonsai-27B-mlx-1bit on the
  // Windows acceptance machine). The engine cannot read MLX packing: recognised as not supported.
  if (hasMlxQuantization(configJson)) return null
  return fromDtype(configJson)
}

/** `config.json`'s MLX-style top-level `quantization` object; `quantization_config` is checked before it. */
function hasMlxQuantization(configJson: JsonObject): boolean {
  return asObject(configJson.quantization) !== undefined
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
  if (hasMlxQuantization(configJson)) {
    return `config.json quantization=${JSON.stringify(configJson.quantization)} (an MLX checkpoint)`
  }
  return `config.json dtype=${JSON.stringify(configDtype(configJson) ?? null)}`
}

/** What NVIDIA ModelOpt calls a checkpoint whose layers carry different formats. */
export const MIXED_PRECISION = 'mixed_precision'

/**
 * The formats a checkpoint actually needs the engine to load. One format for every checkpoint but a
 * ModelOpt `MIXED_PRECISION` one, whose `hf_quant_config.json` lists a `quant_algo` per layer in
 * `quantization.quantized_layers` (e.g. `NVFP4` + `FP8`, or `W4A16_NVFP4` + `FP8`): every distinct
 * per-layer format, named by the same rule as a whole-checkpoint `quant_algo`. An empty list means
 * the mixed checkpoint names no per-layer format at all, which the caller must reject.
 */
export function quantizationComponents(format: string, hfQuantConfigJson: JsonObject | null): string[] {
  if (format !== MIXED_PRECISION) return [format]
  const quantization = hfQuantConfigJson === null ? undefined : asObject(hfQuantConfigJson.quantization)
  const layers = quantization === undefined ? undefined : asObject(quantization.quantized_layers)
  if (layers === undefined) return []
  const formats = new Set<string>()
  for (const layer of Object.values(layers)) {
    const quantAlgo = asNonEmptyString(asObject(layer)?.quant_algo)
    if (quantAlgo === undefined) return []
    formats.add(renameFp8PbWo(quantAlgo))
  }
  return [...formats].sort()
}
