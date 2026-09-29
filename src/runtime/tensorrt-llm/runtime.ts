/**
 * The `tensorrt-llm` provider (task 2.14, spec `tensorrt-llm-runtime`): a `LocalRuntime` on the
 * engine-neutral managed-text lifecycle (`../managed-text/`), registered by core only on Linux. What
 * this file adds on top of the lifecycle is the provider's own part of a load:
 *
 *  - refusing it before any container exists — no Docker, no `ready` installation
 *    (`MANAGED_ADAPTER_UNAVAILABLE`), settings the adapter rejects (`INVALID_ARGUMENT`), a model that
 *    is not installed, a host with no NVIDIA card, an embedding request;
 *  - the card: the saved `gpu_id` when the probe still finds it, otherwise the one with the most
 *    memory (`selectLaunchGpu`), with the replacement reported on every load event;
 *  - one session at a time, and one resident model per card: the lifecycle's `stopping-previous`
 *    stage asks core's GPU residency (`claimGpu`, task 2.15) to stop every other `tensorrt-llm`
 *    model and every other engine on the chosen card, each with a confirmed exit, before this one's
 *    container is created — or, with no residency wired, stops the other `tensorrt-llm` models itself;
 *  - what a session can do (`routePolicy`, `capabilities`), read off the pinned descriptor's
 *    `model_families` entry for the model's architecture — never guessed (design D9);
 *  - never growing a context or recreating a session: a restart of a multi-minute container in the
 *    middle of a conversation is worse than an honest `context_length_exceeded` (design D9);
 *  - the pre-launch check (task 2.16), split in two (round 1, finding 1 (Critical)): before
 *    `stopPrevious` runs, `verifyModelFilesAndCompatibility` (`prelaunch.ts`) re-verifies every file
 *    `model.yml` recorded present on disk at its size, and recomputes architecture/format/compute-
 *    capability against `config.json`/`hf_quant_config.json` as they sit in the model's directory
 *    right now — never memory, which the model this load is about to replace may still be holding on
 *    the very same card. Memory is checked after `stopPrevious`, through the lifecycle's own
 *    `beforeCreate` hook (`checkMemoryBeforeCreate` below), which re-probes the chosen card's free
 *    memory once whatever `stopPrevious` freed is actually free;
 *  - `family` (tools/structured output/route policy) is read off the descriptor's `model_families`
 *    entry for the *verified* `config.json` architecture (finding 5) — `model.yml`'s own copy of the
 *    architecture is never consulted for this, since the pre-launch check may have found it stale.
 *
 * Everything that touches the machine arrives injected: the lifecycle over the core's one Docker
 * executor, the ready installation, the host facts, the model lookup and the stored settings.
 */
import { AtomicCoreError } from '../../contracts/index.js'
import type {
  ModelFamilySupport,
  RuntimeDescriptor,
  SessionInfo,
  UnloadResult,
} from '../../contracts/index.js'
import type { ModelCapabilities } from '../../models/index.js'
import type {
  ManagedLastAttempt,
  ManagedTextCapabilities,
  ManagedTextLifecycle,
} from '../managed-text/index.js'
import { throwIfLoadCancelled } from '../shared/index.js'
import type {
  CtxIncreaseResult,
  GpuClaimHook,
  GpuOccupancy,
  LocalLoadOptions,
  LocalRuntime,
  RecreateResult,
  SessionRoutePolicy,
} from '../shared/index.js'
import { tensorrtLlmAdapter } from './adapter.js'
import { checkModelMemory, selectLaunchGpu } from './compatibility.js'
import type { MemorySizingInputs, ResolvedCheckpoint } from './compatibility.js'
import type { TensorrtLlmHostFacts } from './host-facts.js'
import type { ReadyInstallation } from './installation.js'
import type { TensorrtLlmModel } from './model-dir.js'
import { verifyModelFilesAndCompatibility } from './prelaunch.js'
import { tensorrtLlmRoutePolicy } from './route-policy.js'
import { tensorrtLlmSettings } from './settings.js'

export interface TensorrtLlmRuntimeDeps {
  /**
   * The lifecycle over the core's one Docker executor and journal (the startup handle the setup
   * operation shares), asked at every load: `null` while this host has no docker CLI — a setup that
   * installs Docker later makes the next load find it, with no restart; rejected, with the cause,
   * when wiring the executor failed. The same instance every time it resolves non-null.
   */
  lifecycle: () => Promise<ManagedTextLifecycle | null>
  /** The `ready` installation, its pinned descriptor and image; rejects with why there is none. */
  readyInstallation: () => Promise<ReadyInstallation>
  /** The cards and SELinux, asked right before each load: a card can disappear between two loads. */
  hostFacts: () => Promise<TensorrtLlmHostFacts>
  model: (modelId: string) => Promise<TensorrtLlmModel>
  /** The provider's stored settings (`settings.get('tensorrt-llm')`), read at every load. */
  settings: () => Record<string, unknown>
  /**
   * Core's GPU residency (spec `gpu-residency`), run as the `stopping-previous` stage: frees the chosen
   * card of every other engine and this provider's other session. Absent, the stage stops only the
   * other `tensorrt-llm` models, itself.
   */
  claimGpu?: GpuClaimHook
}

/**
 * `GET /models/tensorrt-llm/:id/capabilities`: the fields every provider's answer has (all false for
 * this engine — no projector, no embedding, no speculative decoding), and the managed engine's own,
 * which the app gates Agent, tools and attachments on (task 3.8).
 */
export type TensorrtLlmModelCapabilities = ModelCapabilities &
  ManagedTextCapabilities & {
    /** The architecture `model.yml` names, which picked the descriptor's `model_families` entry. */
    architecture: string | null
  }

/** `GET /models/tensorrt-llm/:id/logs`: the loaded container's live tail, or the last failed attempt's. */
export type TensorrtLlmModelLogs =
  | { model_id: string; source: 'session'; generation: string; log_tail: string }
  | {
      model_id: string
      source: 'last-attempt'
      generation: string
      log_tail: string
      error: ManagedLastAttempt['error']
      at: number
    }
  | { model_id: string; source: null; log_tail: '' }

const NONE: ManagedTextCapabilities = {
  tools: false,
  reasoning: false,
  structured_output: false,
  vision: false,
  embeddings: false,
  responses: false,
}

/** `capabilities()`'s own lookup, off `model.yml`'s architecture: no disk verification runs for it. */
function familyOf(ready: ReadyInstallation, model: TensorrtLlmModel): ModelFamilySupport | null {
  if (model.architecture === null) return null
  return ready.descriptor.model_families[model.architecture] ?? null
}

/**
 * The load path's own lookup (finding 5): off the *verified* `config.json` architecture
 * (`ResolvedCheckpoint.architectures[0]`, from the pre-launch check), never `model.yml`'s — the two
 * can disagree (a stale `model.yml`, or none at all), and only the one the compatibility check just
 * confirmed against the descriptor's `supported_architectures` is trustworthy enough to gate what a
 * session is allowed to do.
 */
function familyFromResolved(
  ready: ReadyInstallation,
  resolved: ResolvedCheckpoint
): ModelFamilySupport | null {
  const architecture = resolved.architectures[0]
  return architecture === undefined ? null : (ready.descriptor.model_families[architecture] ?? null)
}

export class TensorrtLlmRuntime implements LocalRuntime {
  private current: ManagedTextLifecycle | null = null
  private closed = false
  /** Removals of the engine in progress: while any holds loads off, every load is refused (M-1). */
  private loadHolds = 0
  /** Generations whose GPU claim succeeded: a load only holds its card from then on. */
  private readonly claimed = new Set<string>()
  /** What each loaded session can do, keyed by model and pinned to the generation it was computed for. */
  private readonly sessionCapabilities = new Map<
    string,
    {
      generation: string
      capabilities: ManagedTextCapabilities
      limits: { contextLength: number; maxOutputTokens: number }
    }
  >()

  constructor(private readonly deps: TensorrtLlmRuntimeDeps) {}

  list(): SessionInfo[] {
    return this.current?.list() ?? []
  }

  findSession(modelId: string): SessionInfo | undefined {
    return this.current?.findSession(modelId)
  }

  getLoadedModels(): string[] {
    return this.list().map((session) => session.model_id)
  }

  isLoading(modelId: string): boolean {
    return this.current?.isLoading(modelId) ?? false
  }

  async load(modelId: string, opts: LocalLoadOptions = {}): Promise<SessionInfo> {
    const { signal } = opts
    this.assertOpen()
    this.assertNotHeldOff(modelId)
    throwIfLoadCancelled(signal)
    if (opts.isEmbedding) {
      throw new AtomicCoreError('INVALID_ARGUMENT', 'tensorrt-llm models do not serve embeddings.', modelId)
    }
    // Validated first, before anything is asked of the machine (spec: schema validation before start).
    const settings = tensorrtLlmSettings(this.deps.settings(), opts.overrides)
    const lifecycle = await this.deps.lifecycle().catch((cause: unknown) => {
      throw new AtomicCoreError(
        'MANAGED_ADAPTER_UNAVAILABLE',
        'The managed container runtime failed to initialise, so tensorrt-llm cannot run models.',
        cause instanceof Error ? cause.message : String(cause)
      )
    })
    if (lifecycle === null) {
      throw new AtomicCoreError(
        'MANAGED_ADAPTER_UNAVAILABLE',
        'Docker is not installed on this machine, so tensorrt-llm cannot run models.'
      )
    }
    // Kept from the first load on: what `list`, `unload` and `shutdown` act on. Nothing is loaded
    // before that, so there is nothing for them to find earlier either.
    this.current = lifecycle
    const ready = await this.deps.readyInstallation()
    throwIfLoadCancelled(signal)
    const model = await this.deps.model(modelId)
    const facts = await this.deps.hostFacts()
    throwIfLoadCancelled(signal)
    this.assertOpen()

    const gpu = selectLaunchGpu(facts.gpus, settings.gpu_id ?? undefined)
    if (gpu === null) {
      throw new AtomicCoreError(
        'MANAGED_PREREQUISITE_BLOCKED',
        'No NVIDIA GPU was found on this machine, so tensorrt-llm cannot load a model.'
      )
    }
    const substituted =
      settings.gpu_id !== null && gpu.gpu_id !== settings.gpu_id
        ? { requested_gpu_id: settings.gpu_id, gpu_id: gpu.gpu_id }
        : undefined
    const memory: MemorySizingInputs = {
      contextLength: settings.context_length,
      kvCacheFreeGpuMemoryFraction: settings.kv_cache_free_gpu_memory_fraction,
    }

    // Pre-launch check, phase 1 (task 2.16, spec "Проверка файлов при загрузке"; round 1, finding 1
    // (Critical)): every file model.yml recorded is still on disk at its size, and architecture/
    // format/compute-capability are recomputed against config.json/hf_quant_config.json as they sit
    // on disk right now — never model.yml's word for it, and never memory, which the model this load
    // is about to replace may still be holding on this very card. No container exists yet; a failure
    // here never creates one.
    const resolved = await verifyModelFilesAndCompatibility(
      model,
      ready.descriptor,
      facts.gpus,
      facts.memAvailableBytes,
      { gpuId: gpu.gpu_id, memory }
    )
    throwIfLoadCancelled(signal)
    this.assertOpen()

    // family from the *verified* config.json architecture, never model.yml's own (finding 5).
    const family = familyFromResolved(ready, resolved)

    const { descriptor } = ready
    // Again right before the lifecycle registers this load (synchronously, inside `lifecycle.load`):
    // a removal that began while this load was probing the host must not find it past the check.
    this.assertNotHeldOff(modelId)
    const session = await lifecycle.load({
      modelId,
      modelPath: model.dir,
      weightBytes: model.weightBytes,
      installation: {
        descriptor_id: descriptor.descriptor_id,
        engine_id: descriptor.engine_id,
        adapter_id: descriptor.adapter_id,
        adapter_contract_version: descriptor.adapter_contract_version,
        image: ready.image,
      },
      family,
      gpuUuid: gpu.gpu_id,
      // No VRAM of its own (design D13): the launch bounds the KV cache by tokens, as the memory
      // check (`checkModelMemory`, same rule) reserved for it.
      unifiedMemory: gpu.total_vram_bytes === null,
      selinux: facts.selinux,
      settings,
      // Always passed, evaluated when the stage runs: a second model that arrived a moment earlier
      // is still found, so two loads racing each other can never both end up running.
      stopPrevious: (stageSignal, generation) =>
        this.stopOthers(lifecycle, { modelId, generation, gpuId: gpu.gpu_id }, stageSignal),
      // Pre-launch check, phase 2 (finding 1): the memory line alone, re-probed fresh once
      // stopPrevious (above) has actually freed the card — never the snapshot `facts` took before
      // eviction, which is why this is a lifecycle hook and not just more code in this function.
      beforeCreate: () => this.checkMemoryBeforeCreate(gpu.gpu_id, descriptor, resolved, memory),
      ...(opts.timeoutSecs !== undefined ? { timeoutMs: opts.timeoutSecs * 1000 } : {}),
      ...(signal !== undefined ? { signal } : {}),
      ...(substituted !== undefined ? { gpuSubstituted: substituted } : {}),
    })
    this.sessionCapabilities.set(modelId, {
      generation: session.generation ?? '',
      capabilities: tensorrtLlmAdapter.capabilities({ settings, family }),
      limits: { contextLength: settings.context_length, maxOutputTokens: settings.max_output_tokens },
    })
    return session
  }

  /**
   * Throws `MANAGED_STOP_UNCONFIRMED` when Docker will not confirm the stop: the card stays reserved
   * and the caller is told, rather than handed a success that is not one.
   */
  async unload(modelId: string): Promise<UnloadResult> {
    await this.current?.unload(modelId)
    this.sessionCapabilities.delete(modelId)
    return { success: true }
  }

  /**
   * Every model holding a card through this provider — loading, ready, stopping, or stopped without
   * Docker's confirmation: what a removal of the engine must unload first (task 2.6), through core's
   * own unload so each model's cross-process claim is released with it (final review M-1).
   */
  residentModels(): string[] {
    return [...new Set((this.current?.reservations() ?? []).map((r) => r.model_id))]
  }

  /**
   * Refuses every load with `MANAGED_OPERATION_CONFLICT` until the returned release is called (final
   * review M-1): a removal of the engine holds loads off for as long as it runs, so no load creates
   * a container on an installation being removed. Holds nest; each release counts once.
   */
  holdOffLoads(): () => void {
    this.loadHolds += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.loadHolds -= 1
    }
  }

  /** Never: the context is fixed when the container starts (design D9, spec "без авто-роста"). */
  autoIncreaseCtx(_modelId: string): Promise<CtxIncreaseResult> {
    return Promise.resolve({ ok: false, reason: 'unsupported' })
  }

  recreateSession(modelId: string): Promise<RecreateResult> {
    return Promise.reject(
      new AtomicCoreError(
        'INVALID_ARGUMENT',
        'A tensorrt-llm session is not recreated in place; unload the model and load it again.',
        modelId
      )
    )
  }

  async shutdown(): Promise<void> {
    this.closed = true
    await this.current?.shutdown()
    this.sessionCapabilities.clear()
  }

  routePolicy(modelId: string): SessionRoutePolicy | undefined {
    const session = this.findSession(modelId)
    if (session === undefined) return undefined
    const known = this.sessionCapabilities.get(modelId)
    // A session with no record of what it can do is treated as able to do nothing optional.
    if (known === undefined || known.generation !== session.generation) return tensorrtLlmRoutePolicy(NONE)
    return tensorrtLlmRoutePolicy(known.capabilities, known.limits)
  }

  /** Answers rather than throws, like every provider's capabilities: all false while nothing resolves. */
  async capabilities(modelId: string): Promise<TensorrtLlmModelCapabilities> {
    const base: TensorrtLlmModelCapabilities = {
      modelId,
      mmprojExists: false,
      isEmbedding: false,
      audio: false,
      gemmaMtp: false,
      dflash: false,
      dflashDrafts: [],
      ...NONE,
      architecture: null,
    }
    try {
      const [ready, model] = await Promise.all([this.deps.readyInstallation(), this.deps.model(modelId)])
      const settings = tensorrtLlmSettings({})
      return {
        ...base,
        ...tensorrtLlmAdapter.capabilities({ settings, family: familyOf(ready, model) }),
        architecture: model.architecture,
      }
    } catch {
      return base
    }
  }

  async logs(modelId: string): Promise<TensorrtLlmModelLogs> {
    const lifecycle = this.current
    const session = lifecycle?.findSession(modelId)
    if (lifecycle && session) {
      return {
        model_id: modelId,
        source: 'session',
        generation: session.generation ?? '',
        log_tail: (await lifecycle.logs(modelId)) ?? '',
      }
    }
    const attempt = lifecycle?.lastAttempt(modelId)
    if (attempt === undefined) return { model_id: modelId, source: null, log_tail: '' }
    return {
      model_id: modelId,
      source: 'last-attempt',
      generation: attempt.generation,
      log_tail: attempt.log_tail,
      error: attempt.error,
      at: attempt.at,
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new AtomicCoreError('CORE_NOT_RUNNING', 'The tensorrt-llm provider is shutting down.')
    }
  }

  private assertNotHeldOff(modelId: string): void {
    if (this.loadHolds > 0) {
      throw new AtomicCoreError(
        'MANAGED_OPERATION_CONFLICT',
        'The TensorRT-LLM engine is being removed; load the model once the removal has finished.',
        modelId
      )
    }
  }

  /**
   * The card each container holds, for core's residency rule: every model past its claim — loading,
   * ready, stopping, or stopped without Docker's confirmation, which still holds the card.
   */
  gpuOccupancy(): GpuOccupancy[] {
    return (this.current?.reservations() ?? [])
      .filter((r) => r.state !== 'loading' || this.claimed.has(r.generation))
      .map((r) => ({
        model_id: r.model_id,
        cards: [r.gpu_uuid],
        auxiliary: false,
        state: r.state,
        ...(r.state === 'stop-unconfirmed' && r.container_id !== null
          ? {
              remedy:
                `Loading again retries the stop; if Docker keeps failing, restart Docker or remove ` +
                `container ${r.container_id} (docker rm -f ${r.container_id}).`,
            }
          : {}),
      }))
  }

  /**
   * The `stopping-previous` stage. With core's residency: its claim on `gpuId`, which stops every other
   * `tensorrt-llm` model (one session at a time) and every other engine on that card, each with a
   * confirmed exit, and refuses with `GPU_BUSY` while one will not stop. Without it: every other
   * `tensorrt-llm` model, loading or loaded, stopped with confirmation. Either way the load holds its
   * card from then on — with residency, from the moment core grants the claim, inside core's turn.
   */
  private async stopOthers(
    lifecycle: ManagedTextLifecycle,
    load: { modelId: string; generation: string; gpuId: string },
    signal: AbortSignal
  ): Promise<void> {
    // Generations whose reservation is gone are forgotten here, never while answering a read.
    const live = new Set(lifecycle.reservations().map((r) => r.generation))
    for (const generation of this.claimed) if (!live.has(generation)) this.claimed.delete(generation)
    const hold = () => {
      this.claimed.add(load.generation)
    }
    if (this.deps.claimGpu) {
      const claim = {
        model_id: load.modelId,
        cards: [load.gpuId],
        auxiliary: false,
        soleSessionOfProvider: true,
      }
      await this.deps.claimGpu(claim, signal, hold)
    } else {
      const others = new Set(lifecycle.reservations().map((r) => r.model_id))
      others.delete(load.modelId)
      for (const other of others) await this.unload(other)
    }
    hold()
  }

  /**
   * The lifecycle's `beforeCreate` hook (task 2.16w round 1, finding 1 (Critical)): the pre-launch
   * check's memory line, re-probed fresh right before the container is actually created — after
   * `stopPrevious` has run, so a model switch on a single-GPU host sees the card the previous
   * session just freed, never a snapshot `load()` took before eviction. `MANAGED_PREREQUISITE_
   * BLOCKED` when the chosen card is no longer on the host at all (the same code a missing card gets
   * earlier in `load()`); `MODEL_INCOMPATIBLE` when it is still there but does not have room.
   */
  private async checkMemoryBeforeCreate(
    gpuId: string,
    descriptor: RuntimeDescriptor,
    resolved: ResolvedCheckpoint,
    memory: MemorySizingInputs
  ): Promise<void> {
    const facts = await this.deps.hostFacts()
    if (!facts.gpus.some((gpu) => gpu.gpu_id === gpuId)) {
      throw new AtomicCoreError(
        'MANAGED_PREREQUISITE_BLOCKED',
        'The selected GPU disappeared before the container could start.',
        gpuId
      )
    }
    const verdict = checkModelMemory(resolved, descriptor, facts.gpus, facts.memAvailableBytes, memory)
    if (!verdict.verdict.ok) {
      const { code, message, details } = verdict.verdict.error
      throw new AtomicCoreError(code, message, details)
    }
  }
}
