import { strataCudaProfile, strataProfileId } from '../../client/strata-contracts.js'
import { isAbsolute, join } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import type { StrataModelDescriptor } from '../../contracts/index.js'
import type { StrataComputeBackend } from '../../engine-builds/index.js'
import { parseStrataSettings } from '../../settings/index.js'
import { strataRamModeBytes } from './strata-check.js'

interface LaunchInput {
  bundle: string
  prepared: string
  source: string
  state: string
  modelId: string
  key: string
  port: number
  backend: StrataComputeBackend
  platform: NodeJS.Platform
  gpuOrdinal?: number
  ramBytes: number
  settings: Record<string, unknown>
  libDirs?: string[]
}
const reject = (message: string): never => {
  throw new AtomicCoreError('MODEL_INCOMPATIBLE', message)
}

/** Maps typed settings to the pinned recipes. Paths and credentials are supplied by the core. */
export function strataLaunchConfig(descriptor: StrataModelDescriptor, input: LaunchInput) {
  const settings = parseStrataSettings(input.settings)
  const context = settings.context_length || descriptor.context_length
  if (context > descriptor.context_length) reject('Strata context exceeds the verified model limit.')
  if (!descriptor.requirements.memory_modes.includes(settings.memory_mode))
    reject('The Strata recipe does not support this memory mode.')
  const metal = input.backend === 'metal'
  if (!metal && (!Number.isSafeInteger(input.gpuOrdinal) || input.gpuOrdinal! < 0))
    reject('The selected GPU could not be mapped to a verified Strata device.')
  if (![input.bundle, input.source, input.prepared, input.state].every((path) => isAbsolute(path)))
    reject('Strata launch requires absolute paths.')
  const profileId = strataProfileId(descriptor)
  const readyPack = strataCudaProfile(profileId)?.readyPack
  const expertsBytes =
    descriptor.files.find((file) => readyPack && file.path === 'pack/experts.bin')?.size ?? 0
  const GiB = 2 ** 30
  if (settings.memory_mode === 'ram' && input.ramBytes < strataRamModeBytes(descriptor))
    reject('The Strata RAM mode requires room for the weights and runtime.')
  if (readyPack && input.ramBytes < 32 * GiB)
    reject('NVFP4 requires 32 GiB of RAM for expert streaming and runtime overhead.')
  const vision = settings.vision === 'auto' && descriptor.capabilities.vision
  const pack = join(readyPack ? input.source : input.prepared, 'pack')
  const source = (name: string) => join(input.source, name)
  const native = source(descriptor.inputs.weights[0]!)
  const i = descriptor.inputs
  const family = descriptor.family
  const exeSuffix = input.platform === 'win32' ? '.exe' : ''
  const deepseek = family === 'deepseek41'
  const qwenDir = join(input.bundle, 'components/qwen')
  const exe = deepseek
    ? join(input.bundle, 'components/deepseek', 'strata-dsv41' + exeSuffix)
    : join(qwenDir, 'strata' + exeSuffix)
  const env: Record<string, string> = {}
  const sycl = input.backend === 'sycl'
  if (sycl) env.ONEAPI_DEVICE_SELECTOR = 'level_zero:' + input.gpuOrdinal
  const args = ['--max-context', String(context)]
  if (deepseek) {
    args.unshift('--pack', pack)
    args.push(
      '--eos',
      '1',
      '--vision',
      vision ? 'gpu' : 'none',
      '--dspark',
      metal || i.drafting === 'none' ? 'none' : 'auto',
      '--experts',
      '6'
    )
    if (!metal && i.drafting === 'dspark') args.push('--dspark-conf', '0.65')
    if (settings.memory_mode !== 'auto')
      args.push('--mmap-experts', settings.memory_mode === 'ssd' ? 'on' : 'off')
    args.push('--profile-readonly')
  } else if (family === 'qwen36') {
    if (metal || input.backend === 'sycl') reject('Qwen3.6 requires a CUDA or HIP Strata build.')
    args.unshift('--native', native)
    args.push('--prefill', 'auto', '--mtp', '2')
  } else {
    args.unshift('--pack', pack, '--native', native)
    if (readyPack) {
      args.push(
        '--native-dense-gguf',
        native,
        '--ple-gguf',
        source(i.ple!),
        '--embd-gguf',
        source(i.embedding!)
      )
    } else {
      const pleIndex = i.weights.length === 1 || profileId.startsWith('swift-') ? 0 : 1
      if (i.weights.length <= 2) args.push('--ple-gguf', source(i.weights[pleIndex]!))
    }
    if (i.expert_profile) args.push('--expert-profile', source(i.expert_profile))
    args.push('--expert-cache', metal ? '64' : 'auto', '--prefill', 'auto')
    if (i.drafting === 'dflash2')
      args.push(
        '--draft',
        'dflash2',
        '--draft-model',
        join(input.prepared, 'draft.pack'),
        '--draft-fallback',
        'none',
        '--mtp-draft-vocab',
        source(i.draft_vocab!),
        '--spec',
        '6',
        '--draft-conf',
        metal ? '0.5' : input.backend === 'sycl' ? '0.6' : '0.35'
      )
    if (
      readyPack &&
      (settings.memory_mode === 'ssd' ||
        (settings.memory_mode === 'auto' && input.ramBytes < expertsBytes + 16 * GiB))
    ) {
      // Strata streams the remaining experts from the pack and retains 24 GiB for the OS and runtime.
      const budget = Math.min(Math.floor(expertsBytes / GiB), Math.floor(input.ramBytes / GiB) - 24)
      args.push('--resident-budget-gib', String(Math.max(8, budget)))
    } else if (metal || settings.memory_mode === 'ssd') args.push('--mmap-experts')
    if (settings.memory_mode === 'ram') args.push('--ple-io', 'ram')
    if (metal && settings.memory_mode !== 'auto')
      env.STRATA_METAL_STREAM = settings.memory_mode === 'ssd' ? '1' : '0'
  }
  if (vision && !deepseek) args.push('--vision')
  return {
    exe,
    args,
    env,
    cwd: join(input.bundle, 'control'),
    tokenizer: join(pack, 'tokenizer'),
    model_name: input.modelId,
    arch: family === 'qwen38' ? 'qwen4exp' : family === 'qwen36' ? 'qwen35moe' : 'deepseek41',
    host: '127.0.0.1',
    port: input.port,
    api_key: input.key,
    parallel: settings.parallel_requests,
    log: join(input.state, 'compute.log'),
    offline: true,
    lazy_load: false,
    idle_unload_s: 0,
    open_browser: false,
    engine_ready_s: settings.timeout,
    lib_dirs: input.libDirs ?? [],
    backend: input.backend.startsWith('cuda') ? 'cuda' : input.backend,
    ...(input.backend === 'cuda12' ? { cuda: 12 } : {}),
    ...(!metal && !sycl ? { gpu: input.gpuOrdinal!, gpus_asked: true, gpus_by: 'person' } : {}),
    ...(vision && !deepseek
      ? {
          vision: {
            exe: join(qwenDir, (input.backend === 'hip' ? 'strata-vision-hip' : 'strata-vision') + exeSuffix),
            ...(input.backend === 'hip' ? { cuda_device: input.gpuOrdinal } : {}),
            model: native,
            mmproj: source(i.vision),
            gpu: true,
            elastic: false,
            max_tokens: 1024,
          },
        }
      : {}),
  }
}
