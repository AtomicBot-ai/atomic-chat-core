/**
 * Hand-ported from the `#[test]` table of `args.rs` in `tauri-plugin-atomic-diffusion` (app commit
 * `767ff6350`); see ADR 2026-09-17-pin-the-diffusion-port-with-hand-ported-tables-and-a-live-test.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type {
  DiffusionFamilyDefaults,
  DiffusionModelFiles,
  DiffusionOffloadPolicy,
  ImageGenerateRequest,
  ImageWorkflowId,
  VideoGenerateRequest,
} from '../contracts/index.js'
import { sampleVideoRequest, sampleVideoSpec } from '../../test/helpers/diffusion-fixtures.js'
import {
  buildImgGenRequest,
  buildServerArgs,
  buildVidGenRequest,
  commandSummaryForLog,
  cpuBackendExtraArgs,
  cpuBackendFlags,
  DIFFUSION_BACKEND_ENV,
  hostEnv,
  imageVaeTilingArea,
  isGgmlUnsupportedOpAbort,
  isM5Brand,
  loadExtraArgs,
  METAL_TE_GPU_ENV,
  metalTextEncoderCpuModules,
  MODULE_ASSIGNMENT_FLAGS_BUILD,
  offloadCpuModules,
  offloadFlags,
  speedFlags,
  VAE_TILING_AREA,
  VIDEO_VAE_TILING_PIXEL_FRAMES,
  VULKAN_VAE_TILING_AREA,
  withoutDeviceBackendFlags,
} from './args.js'
import type { ArgsHost } from './args.js'
import type { ResolvedInputs, ServerSpec } from './types.js'

const MAC: ArgsHost = { platform: 'darwin', env: {} }
const LINUX: ArgsHost = { platform: 'linux', env: {} }
/** The first build conf served, which knows only `--diffusion-fa` and `--diffusion-conv-direct`. */
const LEGACY_TAG = 'master-849-d04e895'
/** The pin as conf's mirror tags it: `--flash-attn` and `--conv-direct`. */
const MODERN_TAG = 'master-1088-32d516c-af0b1071'

function spec(files: DiffusionModelFiles, offload: DiffusionOffloadPolicy): ServerSpec {
  return {
    binaryDir: '/opt/sd',
    engine: 'sd-cpp',
    backend: 'metal',
    backendId: 'macos-arm64',
    tag: LEGACY_TAG,
    modelId: 'z-image:q4_k_m',
    family: 'z-image',
    modality: 'image',
    displayName: 'Z-Image Turbo',
    files,
    defaults: { steps: 8, cfgScale: 1.0, width: 1024, height: 1024 },
    ranges: { steps: [1, 50], dims: [256, 2048], dimMultiple: 16 },
    offload,
    extraArgs: [],
    startupTimeoutMs: 600_000,
    cpuFallback: false,
  }
}

const zImageFiles = (): DiffusionModelFiles => ({
  diffusionModel: '/models/z-image/z-image-turbo-Q4_K_M.gguf',
  vae: '/models/shared/ae.safetensors',
  llm: '/models/shared/Qwen3-4B-Q8_0.gguf',
})

const valueAfter = (args: string[], flag: string): string | undefined => {
  const at = args.indexOf(flag)
  return at < 0 ? undefined : args[at + 1]
}

describe('buildServerArgs', () => {
  it('emits every family flag in supply order', () => {
    const files: DiffusionModelFiles = {
      diffusionModel: '/m/transformer.gguf',
      vae: '/m/vae.safetensors',
      vaeFormat: 'flux2',
      clipL: '/m/clip_l.safetensors',
      t5xxl: '/m/t5xxl.gguf',
      llm: '/m/qwen3.gguf',
      llmVision: '/m/qwen3-mmproj.gguf',
    }
    const args = buildServerArgs(spec(files, 'none'), 4242, '/s', MAC)
    const idx = (flag: string) => args.indexOf(flag)
    expect(args.slice(0, 2)).toEqual(['--diffusion-model', '/m/transformer.gguf'])
    expect(idx('--vae')).toBeLessThan(idx('--clip_l'))
    expect(idx('--clip_l')).toBeLessThan(idx('--t5xxl'))
    expect(idx('--t5xxl')).toBeLessThan(idx('--llm'))
    expect(idx('--llm')).toBeLessThan(idx('--llm_vision'))
    expect(valueAfter(args, '--llm_vision')).toBe('/m/qwen3-mmproj.gguf')
    expect(valueAfter(args, '--vae-format')).toBe('flux2')
    expect(idx('--vae-format')).toBeLessThan(idx('--listen-ip'))
    expect(valueAfter(args, '--listen-ip')).toBe('127.0.0.1')
    expect(valueAfter(args, '--listen-port')).toBe('4242')
    for (const flag of ['--lora-model-dir', '--hires-upscalers-dir', '--embd-dir'])
      expect(valueAfter(args, flag), flag).toBe('/s')
    expect(args).toContain('-v')
  })

  it('omits optional files and the VAE format when they are absent or empty', () => {
    const args = buildServerArgs(spec(zImageFiles(), 'none'), 1, '/s', MAC)
    for (const flag of ['--clip_l', '--t5xxl', '--llm_vision', '--qwen2vl', '--vae-format', '--threads'])
      expect(args, flag).not.toContain(flag)
    expect(valueAfter(args, '--llm')).toBe('/models/shared/Qwen3-4B-Q8_0.gguf')

    const empty = buildServerArgs(
      spec({ diffusionModel: '/m/x.gguf', vae: '', vaeFormat: '' }, 'none'),
      1,
      '/s',
      MAC
    )
    expect(empty).not.toContain('--vae')
    expect(empty).not.toContain('--vae-format')
  })

  it('hands a qwen2vl file over as --llm, the slot its deprecated alias names, and keeps it over an llm file', () => {
    const qwenImage = { diffusionModel: '/m/qwen-image.gguf', qwen2vl: '/m/qwen2.5-vl.gguf' }
    const args = buildServerArgs(spec(qwenImage, 'none'), 1, '/s', LINUX)
    expect(valueAfter(args, '--llm')).toBe('/m/qwen2.5-vl.gguf')
    expect(args).not.toContain('--qwen2vl')
    // The old argv said `--llm` and then `--qwen2vl`; the second won.
    const both = buildServerArgs(spec({ ...qwenImage, llm: '/m/qwen3.gguf' }, 'none'), 1, '/s', LINUX)
    expect(both.filter((a) => a === '--llm')).toHaveLength(1)
    expect(valueAfter(both, '--llm')).toBe('/m/qwen2.5-vl.gguf')
  })

  it('passes threads when they are set', () => {
    const args = buildServerArgs({ ...spec(zImageFiles(), 'none'), threads: 6 }, 1, '/s', MAC)
    expect(valueAfter(args, '--threads')).toBe('6')
  })

  it('maps the offload policies to the documented flags and modules', () => {
    expect(offloadFlags('none')).toEqual([])
    expect(offloadFlags('group')).toEqual(['--offload-to-cpu'])
    expect(offloadFlags('model')).toEqual(['--offload-to-cpu', '--vae-tiling'])
    expect(offloadCpuModules('none')).toEqual([])
    expect(offloadCpuModules('group')).toEqual([])
    expect(offloadCpuModules('model')).toEqual(['te', 'vae'])
  })

  it('puts the CPU modules in one --backend, each once, the text encoder first', () => {
    expect(cpuBackendFlags([])).toEqual([])
    expect(cpuBackendFlags(['te'])).toEqual(['--backend', 'te=cpu'])
    expect(cpuBackendFlags(['vae'])).toEqual(['--backend', 'vae=cpu'])
    expect(cpuBackendFlags(['vae', 'te', 'te'])).toEqual(['--backend', 'te=cpu,vae=cpu'])
  })

  it('spells the speed flags for the build: the module assignments from 982 on, the old flags before', () => {
    const modern = ['--flash-attn', 'off,diffusion=on', '--conv-direct', 'auto,diffusion=on,controlnet=on']
    const legacy = ['--diffusion-fa', '--diffusion-conv-direct']
    expect(MODULE_ASSIGNMENT_FLAGS_BUILD).toBe(982)
    expect(speedFlags(982)).toEqual(modern)
    expect(speedFlags(1091)).toEqual(modern)
    expect(speedFlags(981)).toEqual(legacy)
    expect(speedFlags(849)).toEqual(legacy)
    // A tag that names no build gets what every build up to the pin still reads.
    expect(speedFlags(undefined)).toEqual(legacy)
    expect(buildServerArgs({ ...spec(zImageFiles(), 'none'), tag: MODERN_TAG }, 1, '/s', LINUX)).toEqual(
      expect.arrayContaining(modern)
    )
    expect(buildServerArgs({ ...spec(zImageFiles(), 'none'), tag: 'unknown' }, 1, '/s', LINUX)).toEqual(
      expect.arrayContaining(legacy)
    )
  })

  it('says each hardware flag once, whatever the policy and the host', () => {
    for (const tag of [LEGACY_TAG, MODERN_TAG])
      for (const offload of ['none', 'group', 'model'] as const)
        for (const host of [MAC, LINUX]) {
          const args = buildServerArgs({ ...spec(zImageFiles(), offload), tag }, 1, '/s', host)
          const flags = args.filter((a) => a.startsWith('--'))
          expect(new Set(flags).size, `${tag} ${offload} ${host.platform}`).toBe(flags.length)
        }
  })

  it('moves the text encoder and the VAE in one --backend under model offload, on macOS too', () => {
    const args = buildServerArgs({ ...spec(zImageFiles(), 'model'), tag: MODERN_TAG }, 1, '/s', MAC)
    expect(args.filter((a) => a === '--backend')).toHaveLength(1)
    expect(valueAfter(args, '--backend')).toBe('te=cpu,vae=cpu')
    expect(valueAfter(args, '--flash-attn')).toBe('off,diffusion=on')
    for (const flag of ['--clip-on-cpu', '--vae-on-cpu', '--diffusion-fa', '--diffusion-conv-direct'])
      expect(args, flag).not.toContain(flag)
  })

  it('pins the text encoder to the CPU on macOS unless overridden', () => {
    expect(metalTextEncoderCpuModules(true, undefined)).toEqual(['te'])
    expect(metalTextEncoderCpuModules(true, '0')).toEqual(['te'])
    expect(metalTextEncoderCpuModules(true, '1')).toEqual([])
    expect(metalTextEncoderCpuModules(true, ' TRUE ')).toEqual([])
    expect(metalTextEncoderCpuModules(true, 'yes')).toEqual([])
    expect(metalTextEncoderCpuModules(true, 'on')).toEqual([])
    expect(metalTextEncoderCpuModules(false, undefined)).toEqual([])

    const onMac = buildServerArgs(spec(zImageFiles(), 'none'), 1, '/s', MAC)
    expect(valueAfter(onMac, '--backend')).toBe('te=cpu')
    const elsewhere = buildServerArgs(spec(zImageFiles(), 'none'), 1, '/s', LINUX)
    expect(elsewhere).not.toContain('--backend')
    const overridden = buildServerArgs(spec(zImageFiles(), 'none'), 1, '/s', {
      platform: 'darwin',
      env: { [METAL_TE_GPU_ENV]: '1' },
    })
    expect(overridden).not.toContain('--backend')
  })

  it('puts extra args last, so they win', () => {
    const args = buildServerArgs(
      { ...spec(zImageFiles(), 'group'), extraArgs: ['--backend', 'cpu'] },
      1,
      '/s',
      MAC
    )
    expect(args.slice(-2)).toEqual(['--backend', 'cpu'])
    expect(args.indexOf('-v')).toBeLessThan(args.length - 2)
  })

  it('emits only flags the pinned engine is checked for', () => {
    const fixture = fileURLToPath(new URL('../../test/fixtures/sdcpp/required-flags.txt', import.meta.url))
    const required = new Set(
      readFileSync(fixture, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#'))
    )
    // `-v` is the short form of the `--verbose` the list names.
    required.add('-v')
    const everything: DiffusionModelFiles = {
      diffusionModel: '/m/a.gguf',
      vae: '/m/b',
      vaeFormat: 'flux2',
      clipL: '/m/c',
      t5xxl: '/m/d',
      llm: '/m/e',
      llmVision: '/m/g',
      qwen2vl: '/m/f',
      audioVae: '/m/h',
      embeddingsConnectors: '/m/i',
    }
    const emitted = new Set<string>()
    for (const tag of [LEGACY_TAG, MODERN_TAG])
      for (const offload of ['none', 'group', 'model'] as const) {
        const full = { ...spec(everything, offload), tag, threads: 4, extraArgs: cpuBackendExtraArgs([]) }
        for (const arg of buildServerArgs(full, 1, '/s', MAC)) if (arg.startsWith('-')) emitted.add(arg)
      }
    expect([...emitted].filter((flag) => !required.has(flag))).toEqual([])
    // The video flags are in the list too; no mode flag, and none of the deprecated aliases.
    expect(required.has('--audio-vae') && required.has('--embeddings-connectors')).toBe(true)
    for (const flag of ['-M', '--qwen2vl', '--clip-on-cpu', '--vae-on-cpu'])
      expect(required.has(flag), flag).toBe(false)
    // And the list names nothing this module stopped emitting.
    required.delete('--verbose')
    expect([...required].filter((flag) => !emitted.has(flag))).toEqual([])
  })
})

describe('the CPU-backend recovery', () => {
  it('strips every --backend pair before pinning the CPU', () => {
    const flags = ['--backend', 'diffusion=CUDA0,te=cpu', '--diffusion-fa', '--backend', 'cpu']
    expect(withoutDeviceBackendFlags(flags)).toEqual(['--diffusion-fa'])
    expect(cpuBackendExtraArgs(flags)).toEqual(['--diffusion-fa', '--backend', 'cpu'])
    // A trailing `--backend` with no value is dropped too.
    expect(withoutDeviceBackendFlags(['-x', '--backend'])).toEqual(['-x'])
  })

  it('keeps the CPU modules’ --backend and appends the bare cpu after it, which sd.cpp joins into all-CPU', () => {
    const recovered = {
      ...spec(zImageFiles(), 'model'),
      tag: MODERN_TAG,
      extraArgs: cpuBackendExtraArgs([]),
      cpuFallback: true,
    }
    const args = buildServerArgs(recovered, 1, '/s', MAC)
    const values = args.flatMap((a, i) => (a === '--backend' ? [args[i + 1]] : []))
    // Joined: `te=cpu,vae=cpu,cpu`, the bare entry being the default for every other module.
    expect(values).toEqual(['te=cpu,vae=cpu', 'cpu'])
    expect(args.slice(-2)).toEqual(['--backend', 'cpu'])
  })

  it('starts a load on the CPU only under ATOMIC_DIFFUSION_BACKEND=cpu', () => {
    expect(DIFFUSION_BACKEND_ENV).toBe('ATOMIC_DIFFUSION_BACKEND')
    for (const value of ['cpu', 'CPU', ' cpu '])
      expect(loadExtraArgs(value), value).toEqual(['--backend', 'cpu'])
    for (const value of [undefined, '', 'metal', 'cuda0', 'cpu,metal'])
      expect(loadExtraArgs(value), String(value)).toEqual([])
  })

  it('needs both markers of the ggml abort signature', () => {
    expect(
      isGgmlUnsupportedOpAbort("ggml_metal_op_encode_impl: error: unsupported op 'RMS_NORM'\nGGML_ABORT ...")
    ).toBe(true)
    expect(isGgmlUnsupportedOpAbort("unsupported op 'RMS_NORM'")).toBe(false)
    expect(isGgmlUnsupportedOpAbort('ggml_abort: out of memory')).toBe(false)
    expect(isGgmlUnsupportedOpAbort('')).toBe(false)
  })
})

function request(overrides: Partial<ImageGenerateRequest> = {}): ImageGenerateRequest {
  return {
    prompt: 'a cat',
    width: 512,
    height: 768,
    steps: 8,
    cfgScale: 1.0,
    batchSize: 2,
    workflow: 'create',
    ...overrides,
  }
}

const NO_INPUTS: ResolvedInputs = { refs: [] }
const PLAIN: DiffusionFamilyDefaults = { steps: 8, cfgScale: 1.0, width: 1024, height: 1024 }
const FLUX: DiffusionFamilyDefaults = {
  ...PLAIN,
  guidance: 3.5,
  samplingMethod: 'euler',
  flowShift: 3.0,
}

describe('buildImgGenRequest', () => {
  it('matches the sd.cpp schema', () => {
    const body = buildImgGenRequest(request(), FLUX, 42, NO_INPUTS)
    expect(body).toEqual({
      prompt: 'a cat',
      negative_prompt: '',
      width: 512,
      height: 768,
      batch_count: 2,
      output_format: 'png',
      seed: 42,
      sample_params: {
        sample_steps: 8,
        sample_method: 'euler',
        flow_shift: 3.0,
        guidance: { txt_cfg: 1.0, distilled_guidance: 3.5 },
      },
    })
  })

  it('sends a distilled schedule at exactly its step count, closed by the 0 sd.cpp runs to', () => {
    const turbo: DiffusionFamilyDefaults = {
      ...PLAIN,
      samplingMethod: 'euler',
      sigmas: [1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568],
    }
    const body = buildImgGenRequest(request({ workflow: 'edit' }), turbo, 1, { refs: ['REF'] })
    expect(body['sample_params']).toEqual({
      sample_steps: 8,
      sample_method: 'euler',
      custom_sigmas: [1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0],
      guidance: { txt_cfg: 1.0 },
    })
    expect(body['ref_images']).toEqual(['REF'])
    // The catalog's list is left as it was.
    expect(turbo.sigmas).toHaveLength(8)
    // Another step count runs the engine's own schedule.
    const six = buildImgGenRequest(request({ steps: 6 }), turbo, 1, NO_INPUTS)
    expect(six['sample_params']).not.toHaveProperty('custom_sigmas')
    expect(buildImgGenRequest(request(), PLAIN, 1, NO_INPUTS)['sample_params']).not.toHaveProperty(
      'custom_sigmas'
    )
  })

  it('sends each workflow its own images', () => {
    const full: ResolvedInputs = { init: 'INIT', mask: 'MASK', refs: ['INIT', 'REF2'] }
    const withWorkflow = (workflow: ImageWorkflowId, strength?: number) =>
      buildImgGenRequest(
        request(strength === undefined ? { workflow } : { workflow, strength }),
        PLAIN,
        1,
        full
      )

    // Create ignores every image, even when the runner resolved some.
    let body = withWorkflow('create', 0.5)
    expect(body).not.toHaveProperty('init_image')
    expect(body).not.toHaveProperty('strength')
    expect(body).not.toHaveProperty('ref_images')

    body = withWorkflow('transform')
    expect(body['init_image']).toBe('INIT')
    expect(body['strength']).toBe(0.75)
    expect(body).not.toHaveProperty('mask_image')

    body = withWorkflow('inpaint', 0.6)
    expect(body['init_image']).toBe('INIT')
    expect(body['mask_image']).toBe('MASK')
    expect(body['strength']).toBe(0.6)

    // The grown border is blank canvas: repaint it fully by default.
    body = withWorkflow('extend')
    expect(body['mask_image']).toBe('MASK')
    expect(body['strength']).toBe(1.0)

    // A re-detail pass keeps most of the enlarged source.
    body = withWorkflow('upscale')
    expect(body['init_image']).toBe('INIT')
    expect(body['strength']).toBe(0.35)
    expect(body).not.toHaveProperty('mask_image')

    for (const workflow of ['reference', 'edit'] as const) {
      body = withWorkflow(workflow, 0.6)
      expect(body['ref_images'], workflow).toEqual(['INIT', 'REF2'])
      expect(body, workflow).not.toHaveProperty('init_image')
      expect(body, workflow).not.toHaveProperty('strength')
    }
  })

  it('sends no image keys for inputs that were not resolved', () => {
    const body = buildImgGenRequest(request({ workflow: 'inpaint' }), PLAIN, 1, NO_INPUTS)
    expect(body).not.toHaveProperty('init_image')
    expect(body).not.toHaveProperty('strength')
    expect(body).not.toHaveProperty('mask_image')
    expect(buildImgGenRequest(request({ workflow: 'edit' }), PLAIN, 1, NO_INPUTS)).not.toHaveProperty(
      'ref_images'
    )
  })

  it('tiles the VAE once the output outgrows 1024 squared', () => {
    const sized = (width: number, height: number, workflow: ImageWorkflowId) =>
      buildImgGenRequest(request({ width, height, workflow }), PLAIN, 1, { init: 'INIT', refs: [] })

    // An ordinary generation is left alone.
    expect(sized(1024, 1024, 'create')).not.toHaveProperty('vae_tiling_params')
    expect(sized(832, 1216, 'create')).not.toHaveProperty('vae_tiling_params')
    // A 2x Upscale of that image is not: 26.6 GB to decode in one piece.
    expect(sized(2048, 2048, 'upscale')['vae_tiling_params']).toEqual({ enabled: true })
    // The size decides, not the workflow.
    expect(sized(1536, 1024, 'create')['vae_tiling_params']).toEqual({ enabled: true })
    expect(VAE_TILING_AREA).toBe(1_048_576)
  })

  it('tiles past the area it is given: Vulkan tiles from above 768 squared (Atomic-Chat#350)', () => {
    const sized = (width: number, height: number) =>
      buildImgGenRequest(request({ width, height }), PLAIN, 1, NO_INPUTS, VULKAN_VAE_TILING_AREA)

    // The 1024² default and the tall FLUX size: a one-graph decode needs a 4.5 GiB im2col tensor,
    // which Vulkan refuses and the scheduler runs on the CPU.
    expect(sized(1024, 1024)['vae_tiling_params']).toEqual({ enabled: true })
    expect(sized(832, 1216)['vae_tiling_params']).toEqual({ enabled: true })
    expect(sized(1024, 768)['vae_tiling_params']).toEqual({ enabled: true })
    // At and below 768² the largest tensor stays well under 4 GiB: one graph, as before.
    expect(sized(768, 768)).not.toHaveProperty('vae_tiling_params')
    expect(sized(512, 512)).not.toHaveProperty('vae_tiling_params')
    expect(VULKAN_VAE_TILING_AREA).toBe(589_824)
    // 4608 bytes per pixel of F16 im2col over 256 channels: under 4 GiB at the threshold.
    expect(VULKAN_VAE_TILING_AREA * 256 * 9 * 2).toBeLessThan(4 * 1024 ** 3)
    expect(1024 * 1024 * 256 * 9 * 2).toBeGreaterThan(4 * 1024 ** 3)
  })

  it('lets request values override the family defaults', () => {
    const body = buildImgGenRequest(
      request({
        guidance: 2.0,
        samplingMethod: 'dpm++2m',
        flowShift: 1.5,
        negativePrompt: 'blurry',
        workflow: 'transform',
        strength: 0.6,
      }),
      FLUX,
      7,
      { init: 'AAAA', refs: [] }
    )
    const sample = body['sample_params'] as Record<string, unknown>
    expect((sample['guidance'] as Record<string, unknown>)['distilled_guidance']).toBe(2.0)
    expect(sample['sample_method']).toBe('dpm++2m')
    expect(sample['flow_shift']).toBe(1.5)
    expect(body['negative_prompt']).toBe('blurry')
    expect(body['init_image']).toBe('AAAA')
    expect(body['strength']).toBe(0.6)
  })

  it('omits guidance, flow shift and the sampler for families without them', () => {
    const body = buildImgGenRequest(request(), PLAIN, 1, NO_INPUTS)
    expect(body['sample_params']).toEqual({ sample_steps: 8, guidance: { txt_cfg: 1.0 } })
    // An empty sampler name is "unset", and it does not fall back to the family's either.
    const blank = buildImgGenRequest(request({ samplingMethod: '' }), FLUX, 1, NO_INPUTS)
    expect(blank['sample_params']).not.toHaveProperty('sample_method')
  })

  it('never sends a batch of zero', () => {
    expect(buildImgGenRequest(request({ batchSize: 0 }), PLAIN, 1, NO_INPUTS)['batch_count']).toBe(1)
  })

  it('serialises whole numbers the way sd.cpp accepts them', () => {
    // sd.cpp takes integers with is_number_integer() and floats with is_number().
    const json = JSON.stringify(buildImgGenRequest(request(), FLUX, 42, NO_INPUTS))
    expect(json).toContain('"sample_steps":8')
    expect(json).toContain('"txt_cfg":1')
    expect(json).toContain('"seed":42')
  })
})

describe('imageVaeTilingArea', () => {
  it('lowers the threshold only while a Vulkan build runs on its device', () => {
    const table: Array<[ServerSpec['backend'], boolean, number]> = [
      ['vulkan', false, VULKAN_VAE_TILING_AREA],
      // The CPU fallback has no per-tensor cap; only memory decides there.
      ['vulkan', true, VAE_TILING_AREA],
      ['metal', false, VAE_TILING_AREA],
      ['cuda', false, VAE_TILING_AREA],
      ['rocm', false, VAE_TILING_AREA],
      ['cpu', false, VAE_TILING_AREA],
    ]
    for (const [backend, cpuFallback, area] of table)
      expect(imageVaeTilingArea({ backend, cpuFallback }), `${backend} cpuFallback=${cpuFallback}`).toBe(area)
  })
})

describe('commandSummaryForLog', () => {
  it('has the basename and the numbers, and no path or prompt', () => {
    const args = buildServerArgs(
      { ...spec(zImageFiles(), 'group'), threads: 4 },
      5151,
      '/secret/scratch',
      MAC
    )
    args.push('--prompt', 'a very private prompt')
    const summary = commandSummaryForLog(args)
    expect(summary).toContain('model=z-image-turbo-Q4_K_M.gguf')
    expect(summary).toContain('port=5151')
    expect(summary).toContain('threads=4')
    expect(summary).not.toContain('/models/')
    expect(summary).not.toContain('/secret')
    expect(summary).not.toContain('private prompt')
    expect(summary).not.toContain('Qwen3')
  })

  it('reads the last value, and the equals form', () => {
    const args = [
      '--diffusion-model=/a/first.gguf',
      '--diffusion-model',
      'C:\\models\\second.gguf',
      '--width',
      '512',
      '--height=768',
      '--steps',
      '4',
      '--seed',
      '9',
    ]
    expect(commandSummaryForLog(args)).toBe('model=second.gguf size=512x768 steps=4 seed=9')
  })

  it('names the backend and shortens anything long', () => {
    const long = `${'x'.repeat(60)}.gguf`
    expect(commandSummaryForLog(['--diffusion-model', `/m/${long}`, '--backend', 'cpu'])).toBe(
      `model=${'x'.repeat(45)}... backend=cpu`
    )
    expect(commandSummaryForLog(['--diffusion-model'])).toBe('')
  })

  it('names every --backend joined, as sd.cpp reads them', () => {
    expect(commandSummaryForLog(['--backend', 'te=cpu,vae=cpu', '-v', '--backend', 'cpu'])).toBe(
      'backend=te=cpu,vae=cpu,cpu'
    )
    expect(commandSummaryForLog(['--backend=te=cpu'])).toBe('backend=te=cpu')
  })
})

describe('the host switches', () => {
  // `recognizes_only_apple_m5_cpu_brands` (`process.rs`, app commit ec1fd3ea7).
  it('recognizes only Apple M5 CPU brands', () => {
    expect(isM5Brand('Apple M5')).toBe(true)
    expect(isM5Brand('Apple M5 Max')).toBe(true)
    expect(isM5Brand('Apple M4 Max')).toBe(false)
    expect(isM5Brand('Intel(R) Core(TM) i9')).toBe(false)
  })

  it('disables the Metal Tensor API only for the Metal backend on an M5 Mac', () => {
    expect(hostEnv('darwin', 'metal', 'Apple M5 Pro')).toEqual({ GGML_METAL_TENSOR_DISABLE: '1' })
    expect(hostEnv('darwin', 'metal', 'Apple M4')).toEqual({})
    expect(hostEnv('darwin', 'metal', undefined)).toEqual({})
    expect(hostEnv('darwin', 'cpu', 'Apple M5')).toEqual({})
    expect(hostEnv('linux', 'metal', 'Apple M5')).toEqual({})
  })
})

describe('the video argv', () => {
  it('passes the audio VAE and the connectors right after the video VAE', () => {
    const args = buildServerArgs(sampleVideoSpec(), 4242, '/s', MAC)
    const idx = (flag: string) => args.indexOf(flag)
    expect(valueAfter(args, '--vae')).toBe('/models/shared/ltx-2.3-22b-distilled_video_vae.safetensors')
    expect(valueAfter(args, '--audio-vae')).toBe('/models/shared/ltx-2.3-22b-distilled_audio_vae.safetensors')
    expect(valueAfter(args, '--embeddings-connectors')).toBe(
      '/models/shared/ltx-2.3-22b-distilled_embeddings_connectors.safetensors'
    )
    expect(idx('--vae')).toBeLessThan(idx('--audio-vae'))
    expect(idx('--audio-vae')).toBeLessThan(idx('--embeddings-connectors'))
    expect(idx('--embeddings-connectors')).toBeLessThan(idx('--llm'))
    expect(args).not.toContain('-M')
    // An image spec never sees them.
    expect(buildServerArgs(spec(zImageFiles(), 'none'), 1, '/s', MAC)).not.toContain('--audio-vae')
  })

  it('never emits sd-cli’s -M, even under the switch that used to opt into it', () => {
    const host: ArgsHost = { platform: 'linux', env: { ATOMIC_DIFFUSION_VID_GEN_MODE_FLAG: '1' } }
    const args = buildServerArgs({ ...sampleVideoSpec(), extraArgs: ['--x'] }, 1, '/s', host)
    expect(args).not.toContain('-M')
    expect(args).not.toContain('vid_gen')
    expect(args.slice(-1)).toEqual(['--x'])
  })
})

/** A request without the named optionals, for `exactOptionalPropertyTypes`. */
function without<K extends keyof VideoGenerateRequest>(
  request: VideoGenerateRequest,
  ...keys: K[]
): VideoGenerateRequest {
  const copy = { ...request }
  for (const key of keys) delete copy[key]
  return copy
}

describe('buildVidGenRequest', () => {
  const NO_VIDEO_INPUTS: ResolvedInputs = { refs: [] }

  it('matches the sd.cpp vid_gen schema, with the distilled sigmas at exactly their step count', () => {
    const spec = sampleVideoSpec()
    expect(buildVidGenRequest(sampleVideoRequest(), spec.defaults, 42, NO_VIDEO_INPUTS)).toEqual({
      prompt: 'a cat walking through a rainy alley',
      negative_prompt: '',
      width: 768,
      height: 512,
      video_frames: 25,
      fps: 24,
      output_format: 'webm',
      seed: 42,
      // 768 × 512 × 49 frames is 19 megapixel-frames: the VAE decodes in tiles.
      vae_tiling_params: { enabled: true },
      sample_params: {
        sample_steps: 8,
        sample_method: 'euler',
        // One sigma per step from the catalog, and the closing 0 sd.cpp needs to run all eight.
        custom_sigmas: [1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0],
        guidance: { txt_cfg: 1.0 },
      },
    })
    // Another step count runs the engine's own schedule.
    const nine = buildVidGenRequest(sampleVideoRequest({ steps: 9 }), spec.defaults, 1, NO_VIDEO_INPUTS)
    expect(nine['sample_params']).not.toHaveProperty('custom_sigmas')
  })

  it('fills the frame count and rate from the family, and passes the request knobs through', () => {
    const spec = sampleVideoSpec()
    const body = buildVidGenRequest(
      without(
        sampleVideoRequest({
          negativePrompt: 'blurry',
          guidance: 3.5,
          flowShift: 3,
          samplingMethod: 'euler_a',
        }),
        'frames',
        'fps'
      ),
      spec.defaults,
      7,
      NO_VIDEO_INPUTS
    )
    expect(body['video_frames']).toBe(121)
    expect(body['fps']).toBe(24)
    expect(body['negative_prompt']).toBe('blurry')
    expect(body['sample_params']).toMatchObject({
      sample_method: 'euler_a',
      flow_shift: 3,
      guidance: { txt_cfg: 1.0, distilled_guidance: 3.5 },
    })
    // A spec without a video block (never loaded as video) still produces a well-formed body.
    const bare = buildVidGenRequest(without(sampleVideoRequest(), 'frames', 'fps'), PLAIN, 1, NO_VIDEO_INPUTS)
    expect(bare['video_frames']).toBe(1)
    expect(bare['fps']).toBe(24)
  })

  it('sends the resolved first and last frames, and tiles the VAE past eight megapixel-frames', () => {
    const spec = sampleVideoSpec()
    const body = buildVidGenRequest(sampleVideoRequest({ frames: 9 }), spec.defaults, 1, {
      refs: [],
      init: 'FIRST',
      end: 'LAST',
    })
    expect(body['init_image']).toBe('FIRST')
    expect(body['end_image']).toBe('LAST')
    // 768 × 512 × 9 is 3.5 megapixel-frames: one graph.
    expect(body).not.toHaveProperty('vae_tiling_params')
    // The frame count counts as much as the frame size: 49 frames of the same size tile …
    expect(
      buildVidGenRequest(sampleVideoRequest({ frames: 49 }), spec.defaults, 1, NO_VIDEO_INPUTS)[
        'vae_tiling_params'
      ]
    ).toEqual({ enabled: true })
    // … and so do 9 frames of 1216².
    const big = buildVidGenRequest(
      sampleVideoRequest({ width: 1216, height: 1216, frames: 9 }),
      spec.defaults,
      1,
      NO_VIDEO_INPUTS
    )
    expect(big['vae_tiling_params']).toEqual({ enabled: true })
    expect(VIDEO_VAE_TILING_PIXEL_FRAMES).toBe(8 * 1_048_576)
  })

  it('tiles the decode as the plan says, whatever the threshold would', () => {
    const spec = sampleVideoSpec()
    const long = sampleVideoRequest({ frames: 49 })
    // Past the threshold, but the plan found room for one graph.
    expect(
      buildVidGenRequest(long, spec.defaults, 1, NO_VIDEO_INPUTS, { tilesX: 1, tilesY: 1 })
    ).not.toHaveProperty('vae_tiling_params')
    // Tile counts, under the spelling of either sd.cpp build.
    expect(
      buildVidGenRequest(long, spec.defaults, 1, NO_VIDEO_INPUTS, { tilesX: 1, tilesY: 3 })[
        'vae_tiling_params'
      ]
    ).toEqual({ enabled: true, rel_size_x: 1, rel_size_y: 3, rel_size_w: 1, rel_size_h: 3 })
    // Below the threshold the plan still decides.
    expect(
      buildVidGenRequest(sampleVideoRequest({ frames: 9 }), spec.defaults, 1, NO_VIDEO_INPUTS, {
        tilesX: 2,
        tilesY: 1,
      })['vae_tiling_params']
    ).toMatchObject({ enabled: true, rel_size_x: 2, rel_size_y: 1 })
  })
})
