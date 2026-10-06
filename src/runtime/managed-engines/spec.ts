/**
 * The managed engine registry (change `add-vllm-runtime`, design D3): what one managed engine is to
 * core, beyond the `ManagedTextAdapter` the container lifecycle runs. A second engine is a new spec,
 * an adapter and a descriptor — never a branch on an engine id in shared code.
 *
 * A spec says where the engine's descriptor comes from, which adapter launches its containers, how
 * its stored settings are read and validated, how the shared compatibility check sizes its memory and
 * which checkpoints its loader cannot read (`check`, design D7), and how the public server routes its
 * sessions. The memory rule and the checkpoint quirks belong to the spec, not to the adapter:
 * `adapter_contract_version` is a contract between a descriptor and a container launch, and the check
 * runs with no Docker and no lifecycle at all.
 *
 * `engine_id` is the provider id. Core has relied on that in four places (residency leftovers, the
 * models of an engine, the removal's unloader, the descriptor of a load); the registry makes it an
 * invariant, checked when core starts.
 */
import type { SessionRoutePolicy } from '../shared/index.js'
import type { DescriptorSource } from '../environment/index.js'
import type { ManagedTextAdapter, ManagedTextCapabilities } from '../managed-text/index.js'
import type { ManagedCheckEngine, ManagedModelCheckEngine } from '../managed-models/index.js'

/** What every managed engine's validated settings carry, whatever else they hold. */
export interface ManagedEngineSettings {
  /** `GPU-<uuid>`/`MIG-<uuid>`, or `null` to let the load pick the card with the most free memory. */
  gpu_id: string | null
  context_length: number
  max_output_tokens: number
}

export interface ManagedEngineSpec<S extends ManagedEngineSettings = ManagedEngineSettings> {
  /** The engine's id in conf and in installations. */
  engine_id: string
  /** The provider id it is registered under: always `engine_id` (the registry checks). */
  provider: string
  /** "TensorRT-LLM", "vLLM": the engine in messages. */
  label: string
  /** conf main's `runtimes/<engine_id>.json`. */
  descriptor: DescriptorSource
  adapter: ManagedTextAdapter<S>
  /**
   * Stored values overlaid by a load's own overrides, reduced to this provider's keys and validated:
   * `INVALID_ARGUMENT` for anything the schema refuses, before a container exists.
   */
  settings(stored: Record<string, unknown>, overrides?: Record<string, unknown>): S
  /** The compatibility check's hooks (memory rule, checkpoint quirks), sized by these settings. */
  check(settings: S): ManagedCheckEngine
  /** What the public server must know about a session to route it honestly. */
  routePolicy(
    capabilities: ManagedTextCapabilities | null,
    limits?: { contextLength: number; maxOutputTokens: number } | null
  ): SessionRoutePolicy
}

/** The check route's side of an engine: its saved card and its memory rule, from stored settings. */
export function managedModelCheckOf<S extends ManagedEngineSettings>(
  spec: ManagedEngineSpec<S>
): ManagedModelCheckEngine {
  return {
    engineId: spec.engine_id,
    gpuIdOf: (settings) => spec.settings(settings).gpu_id ?? null,
    checkEngineOf: (settings) => spec.check(spec.settings(settings)),
  }
}

/** The engines this core can run, in priority order of registration. */
export class ManagedEngineRegistry {
  private readonly specs = new Map<string, ManagedEngineSpec>()

  /** Throws when the spec breaks the registry's invariants: a programming error, found at startup. */
  register<S extends ManagedEngineSettings>(spec: ManagedEngineSpec<S>): void {
    if (spec.engine_id !== spec.provider) {
      throw new Error(
        `Managed engine ${spec.label}: engine_id "${spec.engine_id}" must equal its provider id "${spec.provider}".`
      )
    }
    if (spec.descriptor.engine_id !== spec.engine_id) {
      throw new Error(
        `Managed engine ${spec.engine_id}: its descriptor source is for "${spec.descriptor.engine_id}".`
      )
    }
    if (this.specs.has(spec.engine_id)) {
      throw new Error(`Managed engine ${spec.engine_id} is already registered.`)
    }
    this.specs.set(spec.engine_id, spec as unknown as ManagedEngineSpec)
  }

  get(engineId: string): ManagedEngineSpec | undefined {
    return this.specs.get(engineId)
  }

  has(engineId: string): boolean {
    return this.specs.has(engineId)
  }

  list(): ManagedEngineSpec[] {
    return [...this.specs.values()]
  }

  /** Every engine's descriptor source, for the descriptor provider. */
  descriptorSources(): DescriptorSource[] {
    return this.list().map((spec) => spec.descriptor)
  }
}
