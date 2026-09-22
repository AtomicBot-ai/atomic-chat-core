import { describe, expect, it } from 'vitest'
import { MANAGED_ERROR_CODES } from './errors.js'
import {
  EXECUTOR_KINDS,
  MANAGED_AVAILABILITY,
  MANAGED_HOST_ACTIONS,
  MANAGED_OPERATION_KINDS,
  MANAGED_PHASES,
  RUNTIME_INSTALLATION_STATUSES,
  type EnvironmentOperation,
  type EnvironmentSnapshot,
  type ManagedHostReceipt,
  type ManagedHostStep,
  type ManagedOperationTarget,
  type ManagedPhase,
  type ModelResolution,
  type RequirementPlan,
  type RuntimeDescriptor,
} from './environment.js'

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
          active_descriptor_id: 'trtllm-1.3.0rc27',
          candidate_descriptor_id: null,
          availability: 'supported',
          status: 'ready',
        },
      ],
      active_operation_id: null,
    }

    const back = roundTrip(snapshot)
    expect(back).toEqual(snapshot)
    expect(back.gpus[0]?.compute_capability).toBe('8.9')
    // VRAM is bytes here, not the MiB the llama.cpp backend probe reports, because the model check
    // compares it against weight bytes.
    expect(back.gpus[0]?.total_vram_bytes).toBe(12_884_901_888)
  })

  it('says a plan changes nothing on a host that already runs containers with a GPU', () => {
    const adopt: RequirementPlan = {
      plan_digest: 'sha256:dd',
      environment_id: 'env-1',
      target: ENVIRONMENT_TARGET,
      availability: 'setup-required',
      recipe_id: 'ubuntu-24.04-adopt',
      recipe_digest: 'sha256:ee',
      adopts_existing_engine: true,
      system_changes: [],
      download_bytes: null,
      required_disk_bytes: 42_000_000_000,
      requires_elevation: false,
      may_require_relogin: false,
      may_require_reboot: false,
      blockers: [],
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
      adopts_existing_engine: false,
      system_changes: ['Install docker-ce', 'Install nvidia-container-toolkit'],
      download_bytes: 17_222_444_000,
      required_disk_bytes: 60_000_000_000,
      requires_elevation: true,
      may_require_relogin: true,
      may_require_reboot: false,
      blockers: [{ code: 'MANAGED_PREREQUISITE_BLOCKED', message: 'No NVIDIA driver was found.' }],
    })

    expect(blocked.availability).toBe('prerequisite-blocked')
    expect(blocked.blockers).toHaveLength(1)
    expect(blocked.blockers[0]?.code).toBe('MANAGED_PREREQUISITE_BLOCKED')
    expect(blocked.may_require_relogin).toBe(true)
  })

  it('answers a model question with a verdict and, when it is no, the reason', () => {
    const runnable: ModelResolution = {
      repository: 'nvidia/Llama-3.1-8B-Instruct-FP8',
      revision: 'main',
      architectures: ['LlamaForCausalLM'],
      quantization: 'FP8',
      weight_bytes: 8_500_000_000,
      files: [
        { path: 'config.json', bytes: 1024 },
        { path: 'model-00001-of-00002.safetensors', bytes: 4_250_000_000 },
      ],
      compatibility: { ok: true },
      gated: false,
    }
    const tooBig: ModelResolution = {
      ...runnable,
      repository: 'meta-llama/Llama-3.1-70B-Instruct',
      quantization: null,
      weight_bytes: 141_000_000_000,
      compatibility: {
        ok: false,
        error: {
          code: 'MODEL_INCOMPATIBLE',
          message: 'Needs about 141 GB of VRAM; this GPU has 12 GB.',
        },
      },
      gated: true,
    }

    expect(roundTrip(runnable)).toEqual(runnable)
    const back = roundTrip(tooBig)
    expect(back.compatibility).toEqual({
      ok: false,
      error: { code: 'MODEL_INCOMPATIBLE', message: 'Needs about 141 GB of VRAM; this GPU has 12 GB.' },
    })
    // An unquantized checkpoint says so with null, so the quantization check has nothing to look up.
    expect(back.quantization).toBeNull()
  })

  it('keeps a descriptor to data: what to run, what the host needs, what it can load', () => {
    const descriptor: RuntimeDescriptor = {
      schema_version: 1,
      descriptor_id: 'trtllm-1.3.0rc27',
      engine_id: 'tensorrt-llm',
      adapter_id: 'tensorrt-llm-pytorch',
      adapter_contract_version: 1,
      image: {
        repository: 'nvcr.io/nvidia/tensorrt-llm/release',
        digest: 'sha256:f7753134fa2049d4fccbcc2e73258d5c71c6dd34d06ec5be38ae750cf6ca121d',
        platform: 'linux/amd64',
      },
      entrypoint_digest: 'sha256:ab',
      minimum_core_version: '0.4.0',
      minimum_app_version: '0.4.0',
      minimum_compute_capability: '8.0',
      supported_architectures: ['LlamaForCausalLM', 'Qwen2ForCausalLM'],
      quantization: [
        { format: 'FP8', min_compute_capability: '8.9' },
        { format: 'NVFP4', min_compute_capability: '12.0' },
      ],
      recipes: [{ executor: 'linux-docker', recipe_id: 'ubuntu-24.04-docker-ce', digest: 'sha256:ee' }],
      curated_models: [
        {
          repository: 'nvidia/Llama-3.1-8B-Instruct-FP8',
          revision: 'main',
          inventory_digest: 'sha256:cd',
          vram_tier_bytes: 12_884_901_888,
          note: 'Measured on RTX 4070.',
        },
      ],
      download_bytes: 17_222_444_000,
      required_disk_bytes: 60_000_000_000,
      notices: ['NVIDIA container terms apply.'],
      exclusions: ['NVFP4 is not available below compute capability 12.0.'],
    }

    const back = roundTrip(descriptor)
    expect(back).toEqual(descriptor)
    // NVFP4 asks for Blackwell; the Ada card above is below that floor, which is what lets the app
    // hide such a checkpoint instead of offering a download that cannot load.
    expect(back.quantization.find((q) => q.format === 'NVFP4')?.min_compute_capability).toBe('12.0')
  })
})

describe('managed enumerations', () => {
  it('keeps the phases a setup can be in, including both waits that need the user to come back', () => {
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

  it('keeps the two host recipes, the two executors and the three operation kinds', () => {
    expect([...MANAGED_HOST_ACTIONS]).toEqual(['linux.install-container-runtime', 'windows.enable-wsl'])
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
  })

  it('keeps the managed error codes, reusing the image-generation spelling for an unloadable model', () => {
    expect([...MANAGED_ERROR_CODES]).toEqual([
      'MANAGED_OPERATION_CONFLICT',
      'MANAGED_OPERATION_NOT_FOUND',
      'MANAGED_REVISION_CONFLICT',
      'MANAGED_CONSENT_REQUIRED',
      'MANAGED_PLAN_CHANGED',
      'MANAGED_HOST_STEP_INVALID',
      'MANAGED_PREREQUISITE_BLOCKED',
      'MANAGED_ADAPTER_UNAVAILABLE',
      'MANAGED_IDENTITY_MISMATCH',
      'MANAGED_STOP_UNCONFIRMED',
      'MANAGED_RESOURCE_IN_USE',
      'MANAGED_METADATA_INVALID',
      'MANAGED_RECEIPT_CONFLICT',
      'MANAGED_ELEVATION_DECLINED',
      'MANAGED_RELOGIN_REQUIRED',
      'MANAGED_REBOOT_REQUIRED',
      'MODEL_INCOMPATIBLE',
      'GPU_BUSY',
      'SESSION_GENERATION_STALE',
    ])
  })
})
