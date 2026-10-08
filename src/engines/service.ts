/**
 * The `/engines` layer (change `unify-engine-lifecycle`, design D1): it only gathers and directs.
 * Each engine of this host is an `EngineHandle` over the system that installs it — the llama.cpp
 * backend service, `engine-builds`, the managed environments — and this class answers the versions
 * of all of them and sends each command to the one it names.
 */

import { AtomicCoreError, ENGINE_IDS } from '../contracts/index.js'
import type {
  EngineId,
  EngineKind,
  EngineOperationStarted,
  EngineUpdateRequest,
  EngineUpdateResult,
  EngineVersions,
  EngineVersionsRequest,
  EngineVersionsResponse,
} from '../contracts/index.js'
import { collectEngineVersions } from './versions.js'

/** One engine of this host, over the system underneath. */
export interface EngineHandle {
  engine: EngineId
  kind: EngineKind
  versions(request: EngineVersionsRequest): Promise<EngineVersions>
  /** `swap` engines answer once applied; a managed engine answers with the operation it began. */
  update(request: EngineUpdateRequest): Promise<EngineUpdateResult | EngineOperationStarted>
}

/**
 * The engines registered on this host, in catalog order: the three llama.cpp providers and sd.cpp
 * everywhere, MLX on macOS, a managed engine where this core offers it (Linux, Windows with Atomic
 * Chat's WSL distribution).
 */
export function hostEngines(platform: NodeJS.Platform, managed: readonly string[]): EngineId[] {
  return ENGINE_IDS.filter((engine) => {
    if (engine === 'mlx') return platform === 'darwin'
    if (engine === 'tensorrt-llm' || engine === 'vllm') return managed.includes(engine)
    return true
  })
}

export interface EnginesServiceDeps {
  engines: readonly EngineHandle[]
}

export class EnginesService {
  private readonly engines: EngineHandle[]

  constructor(deps: EnginesServiceDeps) {
    this.engines = [...deps.engines].sort(
      (a, b) => ENGINE_IDS.indexOf(a.engine) - ENGINE_IDS.indexOf(b.engine)
    )
  }

  /** The handle of an engine this host has; `INVALID_ARGUMENT` for any other name. */
  private handle(engine: string): EngineHandle {
    const handle = this.engines.find((candidate) => candidate.engine === engine)
    if (handle !== undefined) return handle
    throw new AtomicCoreError(
      'INVALID_ARGUMENT',
      (ENGINE_IDS as readonly string[]).includes(engine)
        ? `The ${engine} engine is not available on this computer.`
        : `There is no engine named ${engine}.`,
      engine
    )
  }

  /** `POST /engines/:engine/update`. */
  async update(
    engine: string,
    request: EngineUpdateRequest
  ): Promise<EngineUpdateResult | EngineOperationStarted> {
    return this.handle(engine).update(request)
  }

  /** `POST /engines/versions`: every engine at once; one engine's failure is its own `error`. */
  versions(request: EngineVersionsRequest = {}): Promise<EngineVersionsResponse> {
    return collectEngineVersions(
      this.engines.map((handle) => ({
        engine: handle.engine,
        kind: handle.kind,
        read: () => handle.versions(request),
      }))
    )
  }
}
