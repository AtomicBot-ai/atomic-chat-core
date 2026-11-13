/**
 * Pure argv and request builders for `sd-server`: no I/O and no process, so every flag decision is
 * tested without a binary or a model file. Port of `args.rs` in `tauri-plugin-atomic-diffusion` (app
 * commit `ec1fd3ea7`, and the host switch of `process.rs`), itself a port of Studio's `sd_cpp_args.py`.
 *
 * Every flag emitted here is in `test/fixtures/sdcpp/engine-contract.json` with the builds that get it
 * (and in `required-flags.txt`); the live test holds the binary's `--help` to the flags of its build.
 */

import type {
  DiffusionBackend,
  DiffusionFamilyDefaults,
  DiffusionOffloadPolicy,
  ImageGenerateRequest,
  VideoGenerateRequest,
} from '../contracts/index.js'
import { sdcppBuildOf } from './compat.js'
import type { ResolvedInputs, ServerSpec } from './types.js'
import { decodeTilingParams } from './video-tiling.js'
import type { VideoDecodeTiling } from './video-tiling.js'
import { defaultStrength, usesInitImage, usesMask, usesReferences, workflowOf } from './workflow.js'

/** Kill switch for the Metal text-encoder placement: `1`/`true`/`yes`/`on` keeps the encoder on Metal. */
export const METAL_TE_GPU_ENV = 'ATOMIC_DIFFUSION_METAL_TE_GPU'

/**
 * The first build with `--flash-attn` and `--conv-direct` (leejet/stable-diffusion.cpp#2134 and the
 * per-module flash attention next to it, both 2026-10-13). From it on `--diffusion-fa` and
 * `--diffusion-conv-direct` are deprecated spellings of what {@link speedFlags} passes; the builds
 * before it know only those, and conf served two of them (849 and 883), which stay installed.
 */
export const MODULE_ASSIGNMENT_FLAGS_BUILD = 982

const truthy = (value: string | undefined): boolean =>
  ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase())

/** The host facts the argv depends on, injected so a test can be any platform. */
export interface ArgsHost {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
}

/** A module this core moves to the CPU backend: the text encoders (`te`) or the VAE. */
export type CpuModule = 'te' | 'vae'

/**
 * The memory policy as sd.cpp flags. `group` streams the weights from RAM (`--offload-to-cpu`);
 * `model` also tiles the VAE, and {@link offloadCpuModules} runs the text encoder and the VAE on the
 * CPU. Flash attention, which both used to add, comes from {@link speedFlags} under every policy.
 */
export function offloadFlags(policy: DiffusionOffloadPolicy): string[] {
  if (policy === 'group') return ['--offload-to-cpu']
  if (policy === 'model') return ['--offload-to-cpu', '--vae-tiling']
  return []
}

/** The modules `policy` runs on the CPU backend: the text encoder and the VAE under `model`. */
export function offloadCpuModules(policy: DiffusionOffloadPolicy): CpuModule[] {
  return policy === 'model' ? ['te', 'vae'] : []
}

/**
 * `modules` on the CPU backend as one `--backend te=cpu,vae=cpu`. `--clip-on-cpu` and `--vae-on-cpu`,
 * deprecated for this spelling, did nothing but prepend the same entries to `--backend` on every build
 * conf has served (849 on). sd.cpp joins a repeated `--backend` with commas and a module's own entry
 * beats the bare default, so the CPU recovery's `--backend cpu`, appended later, still moves the rest.
 */
export function cpuBackendFlags(modules: readonly CpuModule[]): string[] {
  const wanted = new Set(modules)
  const entries = (['te', 'vae'] as const).filter((m) => wanted.has(m)).map((m) => `${m}=cpu`)
  return entries.length === 0 ? [] : ['--backend', entries.join(',')]
}

/**
 * Numerically exact speed-ups: flash attention in the diffusion model only, direct convolution in the
 * diffusion model and ControlNet. From {@link MODULE_ASSIGNMENT_FLAGS_BUILD} on they are the module
 * assignments `--diffusion-fa` and `--diffusion-conv-direct` are deprecated for (the flash-attention
 * one is byte for byte what `--diffusion-fa` sets); older builds, and a tag that names no build, get
 * the old two flags.
 */
export function speedFlags(build: number | undefined): string[] {
  if (build !== undefined && build >= MODULE_ASSIGNMENT_FLAGS_BUILD)
    return ['--flash-attn', 'off,diffusion=on', '--conv-direct', 'auto,diffusion=on,controlnet=on']
  return ['--diffusion-fa', '--diffusion-conv-direct']
}

/**
 * Keep the text encoder on the CPU under Apple Metal. ggml's Metal backend aborts on `RMS_NORM` for
 * non-contiguous rows with no per-op CPU fallback, so an LLM text encoder (Qwen3 for Z-Image and
 * FLUX.2, T5 for FLUX.1) takes the whole server down on the first prompt. The encoder runs once per
 * prompt and the denoiser every step, so pinning only the encoder keeps Metal where it matters.
 */
export function metalTextEncoderCpuModules(isMacos: boolean, envOverride: string | undefined): CpuModule[] {
  if (!isMacos) return []
  return truthy(envOverride) ? [] : ['te']
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

/**
 * `cpu` starts every load on the CPU backend. The engine candidate check sets it through the live
 * test: a macOS CI runner's GPU is a paravirtual device that ggml's Metal kernels crash on. No
 * other value does anything.
 */
export const DIFFUSION_BACKEND_ENV = 'ATOMIC_DIFFUSION_BACKEND'

/** The `extraArgs` a load starts with: the CPU backend under `ATOMIC_DIFFUSION_BACKEND=cpu`, else none. */
export function loadExtraArgs(envValue: string | undefined): string[] {
  return (envValue ?? '').trim().toLowerCase() === 'cpu' ? cpuBackendExtraArgs([]) : []
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
 * directories sd-server insists on iterating, threads, the hardware flags (each once, stable order,
 * spelled for the build `spec.tag` names), `-v` so the per-step sampling lines are printed, and the
 * caller's `extraArgs` last. No mode flag: sd-server takes its modes from the model, and `-M` is sd-cli's.
 */
export function buildServerArgs(
  spec: ServerSpec,
  port: number,
  scratchDir: string,
  host: ArgsHost
): string[] {
  const { files } = spec
  const args = ['--diffusion-model', files.diffusionModel]
  // `--qwen2vl` is a deprecated alias of `--llm`: one slot, the last flag wins. Qwen-Image's
  // Qwen2.5-VL encoder goes in as `--llm`, and a spec naming both still gets its `qwen2vl` file.
  const optional: Array<[string, string | undefined]> = [
    ['--vae', files.vae],
    ['--audio-vae', files.audioVae],
    ['--embeddings-connectors', files.embeddingsConnectors],
    ['--clip_l', files.clipL],
    ['--t5xxl', files.t5xxl],
    ['--llm', files.qwen2vl || files.llm],
    ['--llm_vision', files.llmVision],
  ]
  for (const [flag, value] of optional) if (value) args.push(flag, value)
  if (files.vaeFormat) args.push('--vae-format', files.vaeFormat)
  args.push('--listen-ip', '127.0.0.1', '--listen-port', String(port))
  for (const flag of ['--lora-model-dir', '--hires-upscalers-dir', '--embd-dir']) args.push(flag, scratchDir)
  if (spec.threads !== undefined) args.push('--threads', String(spec.threads))
  args.push(
    ...offloadFlags(spec.offload),
    ...cpuBackendFlags([
      ...offloadCpuModules(spec.offload),
      ...metalTextEncoderCpuModules(host.platform === 'darwin', host.env[METAL_TE_GPU_ENV]),
    ]),
    ...speedFlags(sdcppBuildOf(spec.tag))
  )
  args.push('-v', ...spec.extraArgs)
  return args
}

/**
 * Output area above which a request turns VAE tiling on. The VAE's compute buffer grows with the
 * pixel count (FLUX.2: 6.7 GB to decode at 1024², 26.6 GB at 2048², where a 2x Upscale lands and
 * where it failed on a 24 GB card). Tiled, the peak stays at the one-tile figure. Up to 1024²
 * nothing changes, except on Vulkan ({@link VULKAN_VAE_TILING_AREA}).
 */
export const VAE_TILING_AREA = 1024 * 1024

/**
 * The tiling threshold on the Vulkan backend, lower than {@link VAE_TILING_AREA} because Vulkan caps
 * single tensors, not just memory (Atomic-Chat#350). ggml's Vulkan backend refuses an op with a
 * tensor larger than the device's `maxStorageBufferRange` / `maxBufferSize` (typically 4 GiB on
 * desktop drivers), and the scheduler runs that op on the CPU instead. A one-graph decode of the
 * FLUX-style VAE (Z-Image, FLUX.1, FLUX.2, FLUX.3) unfolds its full-resolution 3×3 convolutions over
 * 256 channels with im2col in F16, 4608 bytes per output pixel, which passes 4 GiB from about
 * 0.93 MP: FLUX.2 Klein's 1024² decode ran on the CPU of a 24 GB RX 7900 XTX (a 7.4 GB CPU buffer,
 * 35–38 s), and tiled it took 2.7 s on the GPU. At 768² that tensor is about 2.5 GiB, well under the
 * cap, so smaller images keep the one-graph decode.
 */
export const VULKAN_VAE_TILING_AREA = 768 * 768

/**
 * The output area above which an image request on `spec` tiles its VAE decode: the Vulkan threshold
 * while the server runs on a Vulkan build's device, the general one elsewhere and after the CPU
 * fallback (the CPU backend has no per-tensor cap).
 */
export function imageVaeTilingArea(spec: Pick<ServerSpec, 'backend' | 'cpuFallback'>): number {
  return spec.backend === 'vulkan' && !spec.cpuFallback ? VULKAN_VAE_TILING_AREA : VAE_TILING_AREA
}

/**
 * Pixel-frames (width × height × frames) above which a video request turns VAE tiling on. A video
 * VAE decodes the whole clip in one graph, so its buffer grows with the frame count as much as with
 * the frame size: the Wan 2.2 VAE asked Metal for 27.6 GB at 1280×704 × 121 frames (≈250 bytes per
 * pixel-frame, 2026-09-23) and failed on a machine with 14.9 GB free. Eight megapixel-frames is
 * about 2 GB of that, the point past which a single-graph decode stops being safe anywhere.
 */
export const VIDEO_VAE_TILING_PIXEL_FRAMES = VAE_TILING_AREA * 8

/**
 * A distilled family's fixed schedule as sd.cpp takes it, or undefined when the request asks for
 * another step count and sd.cpp builds its own. The catalog lists one sigma per step; sd.cpp runs
 * `custom_sigmas.length - 1` steps (`GenerationRequest` in its `src/pipeline/request.cpp`), so the
 * closing 0 is appended here. Without it the last step never runs and the output keeps the noise of
 * the last listed sigma.
 */
function customSigmas(defaults: DiffusionFamilyDefaults, steps: number): number[] | undefined {
  if (defaults.sigmas === undefined || defaults.sigmas.length !== steps) return undefined
  return [...defaults.sigmas, 0]
}

/**
 * The `POST /sdcpp/v1/img_gen` body. The whole batch goes in one request; guidance is split the way
 * sd.cpp expects (CFG → `txt_cfg`, FLUX distilled → `distilled_guidance`). Only set keys are sent,
 * so the server's own defaults apply to the rest. `custom_sigmas` goes in when the family ships a
 * fixed schedule for exactly this many steps (Qwen Image 2.1 Turbo). The workflow decides which
 * images go in. sd.cpp resizes the init image to `width`×`height` itself, which is how Upscale works.
 *
 * sd.cpp reads integers with `is_number_integer()` and floats with `is_number()`, so `1` for a
 * `cfgScale` of 1.0 is accepted (checked in its `common.cpp`). The VAE decode is tiled past
 * `tilingArea` pixels: {@link imageVaeTilingArea} of the running server.
 */
export function buildImgGenRequest(
  request: ImageGenerateRequest,
  defaults: DiffusionFamilyDefaults,
  seed: number,
  inputs: ResolvedInputs,
  tilingArea: number = VAE_TILING_AREA
): Record<string, unknown> {
  const guidance: Record<string, unknown> = { txt_cfg: request.cfgScale }
  const distilled = request.guidance ?? defaults.guidance
  if (distilled !== undefined) guidance['distilled_guidance'] = distilled

  const sampleParams: Record<string, unknown> = { sample_steps: request.steps }
  const method = request.samplingMethod ?? defaults.samplingMethod
  if (method) sampleParams['sample_method'] = method
  const shift = request.flowShift ?? defaults.flowShift
  if (shift !== undefined) sampleParams['flow_shift'] = shift
  const sigmas = customSigmas(defaults, request.steps)
  if (sigmas !== undefined) sampleParams['custom_sigmas'] = sigmas
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
  if (request.width * request.height > tilingArea) body['vae_tiling_params'] = { enabled: true }
  return body
}

/**
 * The `POST /sdcpp/v1/vid_gen` body: one clip, the frame count and rate resolved against the family,
 * `custom_sigmas` when the family ships a fixed schedule for exactly this many steps (LTX-2 distilled),
 * VP8 in WebM (the one container the app plays), and the first and last frames when a later workflow
 * resolves them. The decode is tiled as `tiling` says (none for one graph); without a tiling the
 * pixel-frame threshold switches sd.cpp's own tiles on. Only set keys are sent, like the image body.
 */
export function buildVidGenRequest(
  request: VideoGenerateRequest,
  defaults: DiffusionFamilyDefaults,
  seed: number,
  inputs: ResolvedInputs,
  tiling?: VideoDecodeTiling
): Record<string, unknown> {
  const guidance: Record<string, unknown> = { txt_cfg: request.cfgScale }
  const distilled = request.guidance ?? defaults.guidance
  if (distilled !== undefined) guidance['distilled_guidance'] = distilled

  const sampleParams: Record<string, unknown> = { sample_steps: request.steps }
  const method = request.samplingMethod ?? defaults.samplingMethod
  if (method) sampleParams['sample_method'] = method
  const shift = request.flowShift ?? defaults.flowShift
  if (shift !== undefined) sampleParams['flow_shift'] = shift
  const sigmas = customSigmas(defaults, request.steps)
  if (sigmas !== undefined) sampleParams['custom_sigmas'] = sigmas
  sampleParams['guidance'] = guidance

  const video = defaults.video
  const body: Record<string, unknown> = {
    prompt: request.prompt,
    negative_prompt: request.negativePrompt ?? '',
    width: request.width,
    height: request.height,
    video_frames: request.frames ?? video?.frames ?? 1,
    fps: request.fps ?? video?.fps ?? 24,
    output_format: 'webm',
    seed,
    sample_params: sampleParams,
  }
  if (inputs.init !== undefined) body['init_image'] = inputs.init
  if (inputs.end !== undefined) body['end_image'] = inputs.end
  const frames = body['video_frames'] as number
  if (tiling) {
    const params = decodeTilingParams(tiling)
    if (params) body['vae_tiling_params'] = params
  } else if (request.width * request.height * frames > VIDEO_VAE_TILING_PIXEL_FRAMES)
    body['vae_tiling_params'] = { enabled: true }
  return body
}

function optionValues(args: readonly string[], option: string): string[] {
  const values: string[] = []
  let i = 0
  while (i < args.length) {
    const arg = args[i] as string
    if (arg === option) {
      const value = args[i + 1]
      if (value !== undefined) values.push(value)
      i += 2
      continue
    }
    if (arg.startsWith(`${option}=`)) values.push(arg.slice(option.length + 1))
    i += 1
  }
  return values
}

function lastOptionValue(args: readonly string[], option: string): string | undefined {
  return optionValues(args, option).at(-1)
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
  // sd.cpp joins a repeated `--backend` with commas: the CPU modules', then the recovery's `cpu`.
  const backends = optionValues(args, '--backend')
  if (backends.length > 0) fields.push(`backend=${compact(backends.join(','), 32)}`)
  return fields.join(' ')
}
