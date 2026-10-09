/**
 * How the owner builds the embedding service: the settings section, the engine gate over the data
 * folder, and the child journal (an embedding process is journalled like any backend, under
 * `provider: 'embedding'`, from the moment it spawns until it is gone). Kept out of `create.ts`, which
 * stays a list of `await`s.
 */

import type { DataLayout } from '../config/index.js'
import type { CoreEvents, EmbeddingSettings } from '../contracts/index.js'
import { createDecisionHttp } from '../decision/index.js'
import type { DecisionHttp } from '../decision/index.js'
import { processStartId } from '../lock/index.js'
import type { ProcessJournal } from '../lock/index.js'
import type { BackendOutputSink } from '../runtime/shared/index.js'
import { EMBEDDING_ENGINE_PROVIDER, EmbeddingEngineResolver } from './engine.js'
import type { EmbeddingEngineResolverDeps } from './engine.js'
import { spawnEmbeddingServer } from './process.js'
import type { EmbeddingProcessHandle, EmbeddingServerSpec, SpawnEmbeddingDeps } from './process.js'
import { EmbeddingService } from './service.js'
import type { EmbeddingServiceDeps } from './service.js'

export interface WireEmbeddingOptions {
  layout: DataLayout
  settings: {
    readonly embedding: EmbeddingSettings
    updateEmbedding(patch: Record<string, unknown>): Promise<unknown>
  }
  /** The `llamacpp-upstream` build the user picked (`version_backend`): tried first when it can run the model. */
  upstreamBackend?: () => string
  journal: Pick<ProcessJournal, 'add' | 'remove'>
  instanceId: string
  emit: <K extends keyof CoreEvents>(name: K, payload: CoreEvents[K]) => void
  /** The core's event bus: a finished llama.cpp install lets an `unsupported` or `failed` module retry. */
  on?: (
    name: 'backend:download-finished',
    listener: (payload: CoreEvents['backend:download-finished']) => void
  ) => () => void
  log: (level: 'info' | 'warn' | 'debug', msg: string) => void
  backendOutput?: BackendOutputSink
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Test seams, straight through. */
  overrides?: {
    http?: DecisionHttp
    spawn?: SpawnEmbeddingDeps['spawn']
    listPacks?: EmbeddingEngineResolverDeps['listPacks']
    schedule?: EmbeddingServiceDeps['schedule']
  }
}

/** The journal record an embedding process gets as soon as it starts, so a crashed owner's successor can reap it. */
export function embeddingJournal(
  journal: Pick<ProcessJournal, 'add' | 'remove'>,
  instanceId: string,
  now: () => number = Date.now
): {
  add(pid: number, port: number, exe: string, modelId: string): Promise<void>
  remove(pid: number): Promise<void>
} {
  return {
    add: async (pid, port, exe, modelId) =>
      journal.add({
        instance_id: instanceId,
        pid,
        process_start_id: (await processStartId(pid)) ?? null,
        exe,
        provider: 'embedding',
        model_id: modelId,
        port,
        started_at: new Date(now()).toISOString(),
      }),
    remove: (pid) => journal.remove(pid),
  }
}

/**
 * A backend install finished: a llama.cpp build lets an `unsupported` or `failed` module try again.
 * Fire and forget, never an unhandled rejection; shared by the event bus and the owner's own route.
 */
export function noticeEmbeddingEngineInstall(
  service: Pick<EmbeddingService, 'onEnginesChanged'>,
  provider: string,
  installed: boolean
): void {
  if (installed && provider === EMBEDDING_ENGINE_PROVIDER)
    void service.onEnginesChanged(provider).catch(() => {})
}

export function wireEmbedding(options: WireEmbeddingOptions): EmbeddingService {
  const http = options.overrides?.http ?? createDecisionHttp()
  const journal = embeddingJournal(options.journal, options.instanceId)
  const resolver = new EmbeddingEngineResolver({
    layout: options.layout,
    ...(options.upstreamBackend ? { preferredUpstream: options.upstreamBackend } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.overrides?.listPacks ? { listPacks: options.overrides.listPacks } : {}),
    log: options.log,
  })
  const spawn = async (spec: EmbeddingServerSpec, signal: AbortSignal): Promise<EmbeddingProcessHandle> => {
    const handle = await spawnEmbeddingServer(spec, {
      http,
      signal,
      log: options.log,
      ...(options.platform ? { platform: options.platform } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.backendOutput ? { backendOutput: options.backendOutput } : {}),
      ...(options.overrides?.spawn ? { spawn: options.overrides.spawn } : {}),
      onSpawned: (pid, port, exe) => journal.add(pid, port, exe, spec.modelId),
      onGone: (pid) => journal.remove(pid).catch(() => {}),
    })
    // From now on the process leaves the journal when it exits, whether it crashed or was stopped.
    void handle.exited.then(() => journal.remove(handle.pid).catch(() => {}))
    return handle
  }
  const service = new EmbeddingService({
    dataFolder: options.layout.root,
    readSettings: () => options.settings.embedding,
    writeSettings: (patch) => options.settings.updateEmbedding(patch),
    resolveEngine: (enginePath, minBuild) => resolver.resolve(enginePath, minBuild),
    rejectEngine: (exe, why) => resolver.reject(exe, why),
    forgetRejectedEngines: () => resolver.forgetRejected(),
    spawn,
    http,
    emit: options.emit,
    log: options.log,
    ...(options.overrides?.schedule ? { schedule: options.overrides.schedule } : {}),
  })
  options.on?.('backend:download-finished', (event) =>
    noticeEmbeddingEngineInstall(service, event.provider, event.success)
  )
  // Not started here: the owner calls `start()` once the facade exists.
  return service
}
