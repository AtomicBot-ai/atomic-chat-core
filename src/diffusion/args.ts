/**
 * Pure argv and request builders for `sd-server`: no I/O and no process, so every flag decision is
 * tested without a binary or a model file. Port of `args.rs` in `tauri-plugin-atomic-diffusion` (app
 * commit `ec1fd3ea7`, and the host switch of `process.rs`), itself a port of Studio's `sd_cpp_args.py`.
 *
 * Every flag emitted here is listed in `test/fixtures/sdcpp/required-flags.txt`, which the live test
 * holds against the pinned binary's `--help`.
 */

import type {
  DiffusionBackend,
  DiffusionFamilyDefaults,
  DiffusionOffloadPolicy,
  ImageGenerateRequest,
} from '../contracts/index.js'
import type { ResolvedInputs, ServerSpec } from './types.js'
import { defaultStrength, usesInitImage, usesMask, usesReferences, workflowOf } from './workflow.js'

/** Kill switch for the Metal text-encoder placement: `1`/`true`/`yes`/`on` keeps the encoder on Metal. */
export const METAL_TE_GPU_ENV = 'ATOMIC_DIFFUSION_METAL_TE_GPU'

/** The host facts the argv depends on, injected so a test can be any platform. */
export interface ArgsHost {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
}

function dedup(flags: readonly string[]): string[] {
  return [...new Set(flags)]
}

/**
 * The memory policy as sd.cpp offload flags. `group` streams the model (`--offload-to-cpu`) with
 * flash attention; `model` also puts CLIP and the VAE on the CPU and tiles the VAE.
 */
export function offloadFlags(policy: DiffusionOffloadPolicy): string[] {
  if (policy === 'group') return ['--offload-to-cpu', '--diffusion-fa']
  if (policy === 'model')
    return ['--offload-to-cpu', '--clip-on-cpu', '--vae-on-cpu', '--diffusion-fa', '--vae-tiling']
  return []
}

/** Numerically exact speed-ups: flash attention, and direct convolution in the diffusion model. */
export function speedFlags(): string[] {
  return ['--diffusion-fa', '--diffusion-conv-direct']
}

/**
 * Keep the text encoder on the CPU under Apple Metal. ggml's Metal backend aborts on `RMS_NORM` for
 * non-contiguous rows with no per-op CPU fallback, so an LLM text encoder (Qwen3 for Z-Image and
 * FLUX.2, T5 for FLUX.1) takes the whole server down on the first prompt. The encoder runs once per
 * prompt and the denoiser every step, so pinning only the encoder keeps Metal where it matters.
 */
export function metalTextEncoderFlags(isMacos: boolean, envOverride: string | undefined): string[] {
  if (!isMacos) return []
  const keepOnGpu = ['1', 'true', 'yes', 'on'].includes((envOverride ?? '').trim().toLowerCase())
  return keepOnGpu ? [] : ['--clip-on-cpu']
}

/** An Apple M5 CPU brand string: `Apple M5`, `Apple M5 Max`. */
export function isM5Brand(brand: string): boolean {
  return brand.split(/\s+/).some((part) => part.startsWith('M5'))
}

/**
 * The environment `sd-server` gets for this host. ggml's Metal Tensor API is unstable on some M5 and
 * macOS combinations: it can fail command buffers, or return NaN latents that come out as white
 * images. On an M5 with the Metal backend it is switched off, which keeps Metal on its mature
 * SIMD-group path; the argv is left alone, because older engine builds reject newer scaling flags.
 */
export function hostEnv(
  platform: NodeJS.Platform,
  backend: DiffusionBackend,
  cpuBrand: string | undefined
): Record<string, string> {
  if (platform === 'darwin' && backend === 'metal' && isM5Brand(cpuBrand ?? ''))
    return { GGML_METAL_TENSOR_DISABLE: '1' }
  return {}
}

/**
 * `flags` with every `--backend <spec>` pair removed. sd.cpp concatenates repeated `--backend`
 * values instead of replacing them, and a per-module entry beats the bare default: appending
 * `--backend cpu` to a spec that still says `diffusion=CUDA0` would leave the denoiser on CUDA.
 */
export function withoutDeviceBackendFlags(flags: readonly string[]): string[] {
  const out: string[] = []
  let skip = false
  for (const flag of flags) {
    if (skip) {
      skip = false
      continue
    }
    if (flag === '--backend') {
      skip = true
      continue
    }
    out.push(flag)
  }
  return out
}

/** The `extraArgs` of the one automatic recovery: everything on the CPU backend. */
export function cpuBackendExtraArgs(extraArgs: readonly string[]): string[] {
  return [...withoutDeviceBackendFlags(extraArgs), '--backend', 'cpu']
}

const GGML_UNSUPPORTED_OP_MARKERS = ['unsupported op', 'ggml_abort']

/**
 * True when the captured output carries a ggml unsupported-op abort. That signature is
 * deterministic for the graph in question: a retry on the same backend fails identically, a CPU
 * restart runs it. No other death may be retried automatically.
 */
export function isGgmlUnsupportedOpAbort(text: string): boolean {
  const lower = text.toLowerCase()
  return GGML_UNSUPPORTED_OP_MARKERS.every((marker) => lower.includes(marker))
}

/**
 * The `sd-server` argv, without the binary. Model files first, then the listener, the scratch
 * directories sd-server insists on iterating, threads, the hardware flags (de-duplicated, stable
 * order), `-v` so the per-step sampling lines are printed, and the caller's `extraArgs` last.
 */
export function buildServerArgs(
  spec: ServerSpec,
  port: number,
  scratchDir: string,
  host: ArgsHost
): string[] {
  const { files } = spec
  const args = ['--diffusion-model', files.diffusionModel]
  const optional: Array<[string, string | undefined]> = [
    ['--vae', files.vae],
    ['--clip_l', files.clipL],
    ['--t5xxl', files.t5xxl],
    ['--llm', files.llm],
    ['--llm_vision', files.llmVision],
    ['--qwen2vl', files.qwen2vl],
  ]
  for (const [flag, value] of optional) if (value) args.push(flag, value)
  if (files.vaeFormat) args.push('--vae-format', files.vaeFormat)
  args.push('--listen-ip', '127.0.0.1', '--listen-port', String(port))
  for (const flag of ['--lora-model-dir', '--hires-upscalers-dir', '--embd-dir']) args.push(flag, scratchDir)
  if (spec.threads !== undefined) args.push('--threads', String(spec.threads))
  args.push(
    ...dedup([
      ...offloadFlags(spec.offload),
      ...speedFlags(),
      ...metalTextEncoderFlags(host.platform === 'darwin', host.env[METAL_TE_GPU_ENV]),
    ])
  )
  args.push('-v', ...spec.extraArgs)
  return args
}

/**
 * Output area above which a request turns VAE tiling on. The VAE's compute buffer grows with the
 * pixel count (FLUX.2: 6.7 GB to decode at 1024², 26.6 GB at 2048², where a 2x Upscale lands and
 * where it failed on a 24 GB card). Tiled, the peak stays at the one-tile figure. Up to 1024²
 * nothing changes.
 */
export const VAE_TILING_AREA = 1024 * 1024

/**
 * The `POST /sdcpp/v1/img_gen` body. The whole batch goes in one request; guidance is split the way
 * sd.cpp expects (CFG → `txt_cfg`, FLUX distilled → `distilled_guidance`). Only set keys are sent,
 * so the server's own defaults apply to the rest. The workflow decides which images go in. sd.cpp
 * resizes the init image to `width`×`height` itself, which is how Upscale works.
 *
 * sd.cpp reads integers with `is_number_integer()` and floats with `is_number()`, so `1` for a
 * `cfgScale` of 1.0 is accepted (checked in its `common.cpp`).
 */
export function buildImgGenRequest(
  request: ImageGenerateRequest,
  defaults: DiffusionFamilyDefaults,
  seed: number,
  inputs: ResolvedInputs
): Record<string, unknown> {
  const guidance: Record<string, unknown> = { txt_cfg: request.cfgScale }
  const distilled = request.guidance ?? defaults.guidance
  if (distilled !== undefined) guidance['distilled_guidance'] = distilled

  const sampleParams: Record<string, unknown> = { sample_steps: request.steps }
  const method = request.samplingMethod ?? defaults.samplingMethod
  if (method) sampleParams['sample_method'] = method
  const shift = request.flowShift ?? defaults.flowShift
  if (shift !== undefined) sampleParams['flow_shift'] = shift
  sampleParams['guidance'] = guidance

  const body: Record<string, unknown> = {
    prompt: request.prompt,
    negative_prompt: request.negativePrompt ?? '',
    width: request.width,
    height: request.height,
    batch_count: Math.max(request.batchSize, 1),
    output_format: 'png',
    seed,
    sample_params: sampleParams,
  }
  const workflow = workflowOf(request)
  if (usesInitImage(workflow)) {
    if (inputs.init !== undefined) {
      body['init_image'] = inputs.init
      body['strength'] = request.strength ?? defaultStrength(workflow)
    }
    if (usesMask(workflow) && inputs.mask !== undefined) body['mask_image'] = inputs.mask
  }
  if (usesReferences(workflow) && inputs.refs.length > 0) body['ref_images'] = inputs.refs
  if (request.width * request.height > VAE_TILING_AREA) body['vae_tiling_params'] = { enabled: true }
  return body
}

function lastOptionValue(args: readonly string[], option: string): string | undefined {
  let value: string | undefined
  let i = 0
  while (i < args.length) {
    const arg = args[i] as string
    if (arg === option) {
      value = args[i + 1] ?? value
      i += 2
      continue
    }
    if (arg.startsWith(`${option}=`)) value = arg.slice(option.length + 1)
    i += 1
  }
  return value
}

function compact(value: string, limit: number): string {
  const chars = [...value]
  return chars.length <= limit ? value : `${chars.slice(0, Math.max(limit - 3, 0)).join('')}...`
}

/** One line for the log: the model's basename and the numeric settings, never a path or a prompt. */
export function commandSummaryForLog(args: readonly string[]): string {
  const fields: string[] = []
  const model = lastOptionValue(args, '--diffusion-model')
  if (model !== undefined) {
    const name = model.replaceAll('\\', '/').split('/').pop() ?? ''
    fields.push(`model=${compact(name, 48)}`)
  }
  const width = lastOptionValue(args, '--width')
  const height = lastOptionValue(args, '--height')
  if (width !== undefined && height !== undefined)
    fields.push(`size=${compact(width, 8)}x${compact(height, 8)}`)
  const numeric: Array<[string, string]> = [
    ['steps', '--steps'],
    ['seed', '--seed'],
    ['port', '--listen-port'],
    ['threads', '--threads'],
  ]
  for (const [label, option] of numeric) {
    const value = lastOptionValue(args, option)
    if (value !== undefined) fields.push(`${label}=${compact(value, 16)}`)
  }
  const backend = lastOptionValue(args, '--backend')
  if (backend !== undefined) fields.push(`backend=${compact(backend, 32)}`)
  return fields.join(' ')
}
