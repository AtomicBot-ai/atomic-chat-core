import { describe, expect, it } from 'vitest'
import {
  EXECUTOR_KINDS,
  MANAGED_AVAILABILITY,
  MANAGED_HOST_ACTIONS,
  MANAGED_OPERATION_KINDS,
  MANAGED_PHASES,
  RUNTIME_INSTALLATION_STATUSES,
  WSL_REASONS,
  type EnvironmentOperation,
  type EnvironmentSnapshot,
  type ManagedHostReceipt,
  type ManagedHostStep,
  type ManagedOperationTarget,
  type ManagedPhase,
  type ModelCompatibility,
  type RequirementPlan,
  type EnvironmentManifest,
  type RuntimeDescriptor,
} from './environment.js'
import { SESSION_LOAD_STAGES } from './session.js'

/** What the wire does to a value: JSON and back, the only transport these shapes travel over. */
const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const ENVIRONMENT_TARGET: ManagedOperationTarget = { kind: 'environment' }
const RUNTIME_TARGET: ManagedOperationTarget = {
  kind: 'runtime',
  installation_id: 'inst-tensorrt-llm',
  engine_id: 'tensorrt-llm',
}

const operation = (
  phase: ManagedPhase,
  target: ManagedOperationTarget = RUNTIME_TARGET
): EnvironmentOperation => ({
  schema_version: 1,
  operation_id: 'op-1',
  request_id: 'req-1',
  environment_id: 'env-1',
  target,
  kind: 'setup',
  instance_id: 'core-1',
  revision: 7,
  phase,
  plan_digest: 'sha256:aa',
  approved_plan_digest: null,
  carried_plan_digest: null,
  progress: null,
  pending_host_step: null,
  completed_step_ids: [],
  cancellation_requested: false,
  error: null,
})

describe('managed environment wire shapes', () => {
  it('survives JSON in every phase, keeping the phase and the nulls it was sent with', () => {
    for (const phase of MANAGED_PHASES) {
      const back = roundTrip(operation(phase))
      expect(back.phase).toBe(phase)
      expect(back).toEqual(operation(phase))
      // A phase with nothing measurable to report says so; it must not arrive as a missing key,
      // or a client cannot tell "no progress yet" from "this build has no progress field".
      expect(back.progress).toBeNull()
      expect('progress' in back).toBe(true)
      expect(back.approved_plan_digest).toBeNull()
    }
  })

  it('keeps an operation on one installation distinct from one on the shared environment', () => {
    const onRuntime = roundTrip(operation('pulling-image', RUNTIME_TARGET)).target
    const onEnvironment = roundTrip(operation('preparing-host', ENVIRONMENT_TARGET)).target

    expect(onRuntime).toEqual({
      kind: 'runtime',
      installation_id: 'inst-tensorrt-llm',
      engine_id: 'tensorrt-llm',
    })
    expect(onEnvironment).toEqual({ kind: 'environment' })
    // The environment target carries no installation: a removal aimed at the environment can never
    // be read as a removal of whichever engine happened to be installed.
    expect('installation_id' in onEnvironment).toBe(false)
  })

  it('reports measured progress with its unit, and an indeterminate step without inventing one', () => {
    const measured = roundTrip({
      ...operation('pulling-image'),
      progress: {
        label: 'Downloading runtime',
        completed: 4_294_967_296,
        total: 17_222_444_000,
        unit: 'bytes',
      },
    })
    const indeterminate = roundTrip({
      ...operation('preparing-environment'),
      progress: { label: 'Preparing environment', completed: null, total: null, unit: 'unknown' },
    })

    expect(measured.progress).toEqual({
      label: 'Downloading runtime',
      completed: 4_294_967_296,
      total: 17_222_444_000,
      unit: 'bytes',
    })
    expect(indeterminate.progress?.completed).toBeNull()
    expect(indeterminate.progress?.total).toBeNull()
  })

  it('carries an unavailable adapter as a failure the app can render, not as a missing field', () => {
    const failed = roundTrip({
      ...operation('failed'),
      error: {
        code: 'MANAGED_ADAPTER_UNAVAILABLE' as const,
        message: 'No compiled adapter is registered for engine "vllm".',
        details: 'adapter_id=vllm-openai',
      },
    })

    expect(failed.error).toEqual({
      code: 'MANAGED_ADAPTER_UNAVAILABLE',
      message: 'No compiled adapter is registered for engine "vllm".',
      details: 'adapter_id=vllm-openai',
    })
    expect(failed.phase).toBe('failed')
  })

  it('pins a privileged step to one revision and one single-use nonce, and its receipt back to both', () => {
    const step: ManagedHostStep = {
      step_id: 'step-1',
      action: 'linux.install-container-runtime',
      recipe_id: 'ubuntu-24.04-docker-ce',
      recipe_digest: 'sha256:bb',
      parameters_digest: 'sha256:cc',
      parameters: {
        user: 'ada',
        arch: 'x86_64',
        family: 'apt',
        distro_id: 'ubuntu',
        version_id: '24.04',
        components: ['docker-engine'],
      },
      nonce: 'once-1',
      expected_operation_revision: 7,
    }
    const receipt: ManagedHostReceipt = {
      step_id: 'step-1',
      nonce: 'once-1',
      expected_operation_revision: 7,
      recipe_digest: 'sha256:bb',
      parameters_digest: 'sha256:cc',
      outcome: 'relogin-required',
      receipt_id: 'receipt-1',
    }

    const pending = roundTrip({ ...operation('preparing-host'), pending_host_step: step })
    expect(pending.pending_host_step).toEqual(step)
    expect(roundTrip(receipt)).toEqual(receipt)
    // The pair is what makes a receipt unreplayable: same nonce, same revision, same recipe bytes.
    expect(receipt.nonce).toBe(step.nonce)
    expect(receipt.expected_operation_revision).toBe(step.expected_operation_revision)
    expect(receipt.recipe_digest).toBe(step.recipe_digest)
  })

  it('orders a snapshot by instance and revision and lists the GPUs a model check needs', () => {
    const snapshot: EnvironmentSnapshot = {
      schema_version: 1,
      environment_id: 'env-1',
      instance_id: 'core-1',
      revision: 12,
      executor: 'wsl-docker',
      availability: 'supported',
      blockers: [],
      selinux: false,
      gpus: [
        {
          gpu_id: 'GPU-0',
          name: 'NVIDIA GeForce RTX 4070',
          compute_capability: '8.9',
          total_vram_bytes: 12_884_901_888,
          free_vram_bytes: 11_811_160_064,
          driver_version: '551.23',
        },
      ],
      installations: [
        {
          installation_id: 'inst-tensorrt-llm',
          engine_id: 'tensorrt-llm',
          environment_id: 'env-1',
          active_descriptor_id: 'tensorrt-llm-1.2.1-r1',
          candidate_descriptor_id: null,
          availability: 'supported',
          status: 'ready',
        },
      ],
      active_operation_id: null,
      minimum_app_version: '2.0.49',
      distribution: null,
    }

    const back = roundTrip(snapshot)
    expect(back).toEqual(snapshot)
    expect(back.gpus[0]?.compute_capability).toBe('8.9')
    // VRAM is bytes here, not the MiB the llama.cpp backend probe reports, because the model check
    // compares it against weight bytes.
    expect(back.gpus[0]?.total_vram_bytes).toBe(12_884_901_888)
  })

  it('names the WSL distribution a Windows environment owns, where it lives and the space it takes', () => {
    const distribution = roundTrip<EnvironmentSnapshot['distribution']>({
      name: 'AtomicChat',
      path: 'C:\\Users\\ada\\AppData\\Local\\AtomicChat\\wsl\\AtomicChat',
      size_bytes: 42_949_672_960,
    })

    expect(distribution).toEqual({
      name: 'AtomicChat',
      path: 'C:\\Users\\ada\\AppData\\Local\\AtomicChat\\wsl\\AtomicChat',
      size_bytes: 42_949_672_960,
    })
    // A size the core could not read is null, never a guessed 0 a client would show as "empty".
    expect(roundTrip({ ...distribution, size_bytes: null }).size_bytes).toBeNull()
  })

  it('carries the enable-WSL step with its own parameters, told apart from the Linux one by action', () => {
    const step: ManagedHostStep = {
      step_id: 'step-2',
      action: 'windows.enable-wsl',
      recipe_id: 'windows.enable-wsl',
      recipe_digest: 'sha256:bb',
      parameters_digest: 'sha256:cc',
      parameters: {},
      nonce: 'once-2',
      expected_operation_revision: 3,
    }

    const back = roundTrip(step)
    expect(back).toEqual(step)
    // Nothing the user typed reaches the elevated process: the step has no parameter at all.
    if (back.action === 'windows.enable-wsl') expect(Object.keys(back.parameters)).toEqual([])
  })

  it('leaves total_vram_bytes null for a unified-memory card that reports none of its own', () => {
    const gpu = roundTrip({
      gpu_id: 'GPU-0',
      name: 'NVIDIA GB10',
      compute_capability: '12.1',
      total_vram_bytes: null,
      free_vram_bytes: null,
      driver_version: '580.10',
    })

    expect(gpu.total_vram_bytes).toBeNull()
    expect(gpu.free_vram_bytes).toBeNull()
  })

  it('says a plan changes nothing on a host that already runs containers with a GPU', () => {
    const adopt: RequirementPlan = {
      plan_digest: 'sha256:dd',
      environment_id: 'env-1',
      target: ENVIRONMENT_TARGET,
      availability: 'setup-required',
      recipe_id: 'ubuntu-24.04-adopt',
      recipe_digest: 'sha256:ee',
      descriptor_id: null,
      environment_manifest_id: null,
      image_digest: null,
      adopts_existing_engine: true,
      system_changes: [],
      download_bytes: null,
      required_disk_bytes: 42_000_000_000,
      docker_root_dir: '/var/lib/docker',
      free_disk_bytes: 100_000_000_000,
      requires_elevation: false,
      may_require_relogin: false,
      may_require_reboot: false,
      blockers: [],
      warnings: [],
    }

    const back = roundTrip(adopt)
    expect(back).toEqual(adopt)
    expect(back.system_changes).toEqual([])
    expect(back.requires_elevation).toBe(false)
  })

  it('reports a blocked prerequisite as a plan with reasons, not as an error response', () => {
    const blocked = roundTrip<RequirementPlan>({
      plan_digest: 'sha256:ff',
      environment_id: 'env-1',
      target: ENVIRONMENT_TARGET,
      availability: 'prerequisite-blocked',
      recipe_id: 'ubuntu-24.04-docker-ce',
      recipe_digest: 'sha256:ee',
      descriptor_id: null,
      environment_manifest_id: null,
      image_digest: null,
      adopts_existing_engine: false,
      system_changes: [
        { code: 'install-packages', text: 'Install docker-ce', params: { packages: 'docker-ce' } },
        { code: 'install-packages', text: 'Install nvidia-container-toolkit' },
      ],
      download_bytes: 17_222_444_000,
      required_disk_bytes: 60_000_000_000,
      docker_root_dir: null,
      free_disk_bytes: null,
      requires_elevation: true,
      may_require_relogin: true,
      may_require_reboot: false,
      blockers: [{ code: 'MANAGED_PREREQUISITE_BLOCKED', message: 'No NVIDIA driver was found.' }],
      warnings: [
        {
          code: 'docker-address-pools-overlap-routes',
          text: 'Docker will not be able to start: every address range it uses is covered by the route 128.0.0.0/1.',
          params: { routes: '128.0.0.0/1' },
        },
      ],
    })

    expect(blocked.availability).toBe('prerequisite-blocked')
    // A warning rides along with the plan and survives the wire as it is (task 2.23, F-4).
    expect(blocked.warnings[0]?.params).toEqual({ routes: '128.0.0.0/1' })
    expect(blocked.blockers).toHaveLength(1)
    expect(blocked.blockers[0]?.code).toBe('MANAGED_PREREQUISITE_BLOCKED')
    expect(blocked.may_require_relogin).toBe(true)
  })

  it('answers a model check with a verdict and, when it is no, the reason and the other cards it fits', () => {
    const runnable: ModelCompatibility = {
      architectures: ['LlamaForCausalLM'],
      quantization_format: 'fp8',
      weight_bytes: 8_500_000_000,
      checked_gpu_id: 'GPU-0',
      curated: true,
      unified_memory: false,
      fits_other_gpus: [],
      verdict: { ok: true },
    }
    const tooBig: ModelCompatibility = {
      ...runnable,
      quantization_format: 'bf16',
      weight_bytes: 141_000_000_000,
      curated: false,
      fits_other_gpus: ['GPU-1'],
      verdict: {
        ok: false,
        error: {
          code: 'MODEL_INCOMPATIBLE',
          message: 'Needs about 141 GB of VRAM; GPU-0 has 12 GB free.',
        },
      },
    }

    expect(roundTrip(runnable)).toEqual(runnable)
    const back = roundTrip(tooBig)
    expect(back.verdict).toEqual({
      ok: false,
      error: { code: 'MODEL_INCOMPATIBLE', message: 'Needs about 141 GB of VRAM; GPU-0 has 12 GB free.' },
    })
    // The other card is named so the caller can suggest it instead of a dead end.
    expect(back.fits_other_gpus).toEqual(['GPU-1'])
    expect(back.curated).toBe(false)
  })

  it('marks a check as unified-memory when it fell back to host RAM for a GB10-style card', () => {
    const verdict: ModelCompatibility = {
      architectures: ['Qwen3ForCausalLM'],
      quantization_format: 'nvfp4',
      weight_bytes: 6_400_000_000,
      checked_gpu_id: 'GPU-0',
      curated: true,
      unified_memory: true,
      fits_other_gpus: [],
      verdict: { ok: true },
    }

    expect(roundTrip(verdict).unified_memory).toBe(true)
  })

  it('reports a null quantization_format when there is no recognised format to name', () => {
    // GGUF is always rejected (spec tensorrt-llm-models: "for GGUF there is llama.cpp"), and a
    // checkpoint whose config.json/hf_quant_config.json the conf naming rule cannot classify is
    // rejected the same way — unidentified rather than guessed at.
    const verdict: ModelCompatibility = {
      architectures: ['LlamaForCausalLM'],
      quantization_format: null,
      weight_bytes: 8_500_000_000,
      checked_gpu_id: 'GPU-0',
      curated: false,
      unified_memory: false,
      fits_other_gpus: [],
      verdict: {
        ok: false,
        error: { code: 'MODEL_INCOMPATIBLE', message: 'GGUF is not supported here; use llama.cpp.' },
      },
    }

    const back = roundTrip(verdict)
    expect(back.quantization_format).toBeNull()
    expect(back.verdict).toEqual({
      ok: false,
      error: { code: 'MODEL_INCOMPATIBLE', message: 'GGUF is not supported here; use llama.cpp.' },
    })
  })

  it('keeps a descriptor to data: what to run per platform, what the host needs, what it can load', () => {
    const descriptor: RuntimeDescriptor = {
      schema_version: 1,
      descriptor_id: 'tensorrt-llm-1.2.1-r1',
      engine_id: 'tensorrt-llm',
      adapter_id: 'tensorrt-llm',
      adapter_contract_version: 1,
      image: {
        'linux/amd64': {
          repository: 'nvcr.io/nvidia/tensorrt-llm/release',
          digest: 'sha256:cb4d8af81c586a90235ae3739b6d4ddc5d8336f2174c8a1c6b573d2e13faf5d7',
        },
        'linux/arm64': {
          repository: 'nvcr.io/nvidia/tensorrt-llm/release',
          digest: 'sha256:297c9c04055e142d53976cb8e7e7b314b0df148bbbaeb178494a80eddd885ecf',
        },
      },
      probe_image: {
        'linux/amd64': {
          repository: 'nvcr.io/nvidia/cuda',
          digest: 'sha256:0f4abb216c6d33bc4932a59d8157f9ad75b818ec17e283a401d9c7ce27efb49f',
        },
        'linux/arm64': {
          repository: 'nvcr.io/nvidia/cuda',
          digest: 'sha256:f9f6d7ce4503015b0a21ff75ee2b2e1fbd28d791d860ede9a5063ecc04cca5fe',
        },
      },
      minimum_core_version: '0.7.0',
      minimum_app_version: '2.0.49',
      minimum_driver_version: '590.44.01',
      minimum_compute_capability: '8.0',
      supported_architectures: ['LlamaForCausalLM', 'Qwen2ForCausalLM'],
      quantization: [
        { format: 'fp8', min_compute_capability: '8.9', excluded_compute_capabilities: [] },
        {
          format: 'fp8_block_scales',
          min_compute_capability: '9.0',
          excluded_compute_capabilities: ['12.0', '12.1'],
        },
      ],
      model_families: {
        Qwen2ForCausalLM: { tool_parser: 'qwen3', reasoning_parser: null, structured_output: true },
      },
      curated_models: [
        {
          repository: 'Qwen/Qwen3-1.7B',
          revision: '70d244cc86ccca08cf5af4e1e306ecf908b1ad5e',
          inventory_digest: 'sha256:3b3d1df5b8945f32ccdfdbfc72db1944d88e207dfae1c5560950a6ea6b034dde',
          vram_tier_bytes: 8_000_000_000,
          note: 'BF16, 4.1 GB of weights.',
        },
      ],
      download_bytes: 21_122_819_324,
      required_disk_bytes: 67_645_734_912,
      notices: ['By pulling and using the TensorRT-LLM container image you accept the NVIDIA EULA.'],
      exclusions: ['Vision and other multimodal models are not supported in this release.'],
    }

    const back = roundTrip(descriptor)
    expect(back).toEqual(descriptor)
    // Both platforms travel together; an installer on arm64 finds its own repository and digest.
    expect(back.image['linux/arm64'].repository).toBe('nvcr.io/nvidia/tensorrt-llm/release')
    expect(back.probe_image['linux/amd64'].digest.startsWith('sha256:')).toBe(true)
    expect(back.quantization[1]?.excluded_compute_capabilities).toEqual(['12.0', '12.1'])
    expect(back.model_families['Qwen2ForCausalLM']).toEqual({
      tool_parser: 'qwen3',
      reasoning_parser: null,
      structured_output: true,
    })
    // Install recipes are the environment manifest's, never the descriptor's.
    expect('recipes' in back).toBe(false)
    expect('entrypoint_digest' in back).toBe(false)
  })

  it('round-trips an environment manifest: a recipe is an id and its distributions, never a command', () => {
    const manifest: EnvironmentManifest = {
      schema_version: 1,
      manifest_id: 'linux-r1',
      platform: 'linux',
      minimum_core_version: '0.7.5',
      recipes: [
        {
          recipe_id: 'linux.install-container-runtime',
          distributions: [{ id: 'ubuntu', version_id: '24.04', arch: 'x86_64' }],
        },
      ],
    }
    expect(roundTrip(manifest)).toEqual(manifest)
  })

  it('round-trips a Windows environment manifest: a rootfs pinned by URL and sha256, and a recipe id', () => {
    const manifest: EnvironmentManifest = {
      schema_version: 1,
      manifest_id: 'windows-r1',
      platform: 'windows',
      minimum_core_version: '0.7.5',
      minimum_windows_build: 22000,
      minimum_wsl_version: '2.4.4',
      rootfs: {
        url: 'https://releases.ubuntu.com/24.04.5/ubuntu-24.04.5-wsl-amd64.wsl',
        sha256: 'bb415d824822c4b878125729af451a5d18fb13d1cf5cbed9a7393ad64ac6039e',
        distribution: { id: 'ubuntu', version_id: '24.04', arch: 'x86_64' },
      },
      guest_recipe_id: 'linux.install-container-runtime',
    }
    expect(roundTrip(manifest)).toEqual(manifest)
    expect('recipes' in manifest).toBe(false)
  })

  it('keeps the phases a setup can be in, including both waits that need the user to come back', () => {
    // The app relays this vocabulary verbatim; a phase added here without a matching app release
    // would arrive as a string the app does not know how to render.
    expect([...MANAGED_PHASES]).toEqual([
      'checking',
      'awaiting-consent',
      'preparing-host',
      'relogin-required',
      'reboot-required',
      'preparing-environment',
      'pulling-image',
      'verifying',
      'activating',
      'removing',
      'ready',
      'removed',
      'cancelling',
      'cancelled',
      'failed',
    ])
  })

  it('exhausts every phase in a map, so a new one cannot be added without being handled', () => {
    // Compile-time guard: `Record<ManagedPhase, …>` fails to typecheck when a phase is added and
    // this table is not. The runtime assertion only proves the table was filled in.
    const terminal: Record<ManagedPhase, boolean> = {
      'checking': false,
      'awaiting-consent': false,
      'preparing-host': false,
      'relogin-required': false,
      'reboot-required': false,
      'preparing-environment': false,
      'pulling-image': false,
      'verifying': false,
      'activating': false,
      'removing': false,
      'ready': true,
      'removed': true,
      'cancelling': false,
      'cancelled': true,
      'failed': true,
    }

    expect(Object.keys(terminal)).toHaveLength(MANAGED_PHASES.length)
    expect(
      Object.entries(terminal)
        .filter(([, isTerminal]) => isTerminal)
        .map(([phase]) => phase)
    ).toEqual(['ready', 'removed', 'cancelled', 'failed'])
  })

  it('keeps the session:load-progress stage vocabulary stable', () => {
    // The app relays this vocabulary verbatim (spec tensorrt-llm-runtime), same reasoning as the
    // MANAGED_PHASES pin above.
    expect([...SESSION_LOAD_STAGES]).toEqual([
      'stopping-previous',
      'starting-container',
      'initializing-engine',
      'ready',
    ])
  })

  it('keeps the enumerated wire vocabularies stable', () => {
    expect([...EXECUTOR_KINDS]).toEqual(['linux-docker', 'wsl-docker'])
    expect([...MANAGED_OPERATION_KINDS]).toEqual(['setup', 'update', 'remove'])
    expect([...MANAGED_AVAILABILITY]).toEqual([
      'supported',
      'setup-required',
      'prerequisite-blocked',
      'unsupported',
    ])
    expect([...RUNTIME_INSTALLATION_STATUSES]).toEqual([
      'absent',
      'installing',
      'ready',
      'updating',
      'removing',
      'failed',
    ])
    expect([...MANAGED_HOST_ACTIONS]).toEqual(['linux.install-container-runtime', 'windows.enable-wsl'])
    // The Windows causes a client switches on (change `add-tensorrt-llm-windows`); the app relays them.
    expect([...WSL_REASONS]).toEqual([
      'wsl-localhost-forwarding',
      'wsl-stopped',
      'wsl-version',
      'wsl1-distribution',
      'virtualization-disabled',
      'foreign-distribution',
    ])
  })
})
