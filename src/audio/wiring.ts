/**
 * How the owner builds the audio service: the child journal adapter (an `audiocpp_server` is
 * journalled like any backend, under `provider: 'audio'`, right after it spawns) and the event bus.
 * Kept out of `create.ts`, which stays a list of `await`s.
 */

import type { DataLayout } from '../config/index.js'
import type { CoreEvents } from '../contracts/index.js'
import { processStartId } from '../lock/index.js'
import type { ProcessJournal } from '../lock/index.js'
import type { BackendOutputSink, GpuClaimHook } from '../runtime/shared/index.js'
import { AudioService } from './service.js'
import type { AudioServiceDeps } from './service.js'

/** The provider id audio generation journals its server and claims the GPU under. */
export const AUDIO_PROVIDER = 'audio'

export interface WireAudioOptions {
  layout: DataLayout
  journal: Pick<ProcessJournal, 'add' | 'remove'>
  instanceId: string
  emit: <K extends keyof CoreEvents>(name: K, payload: CoreEvents[K]) => void
  log: (level: 'info' | 'warn' | 'debug', msg: string) => void
  /** Every stdout/stderr line `audiocpp_server` prints, for the life of the session. */
  backendOutput?: BackendOutputSink
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Core's GPU residency, asked before every `audiocpp_server` spawn. */
  claimGpu?: GpuClaimHook
  /** Test seams, straight through to the service. */
  overrides?: Pick<
    AudioServiceDeps,
    'http' | 'spawn' | 'timings' | 'idleTickMs' | 'now' | 'sleep' | 'drawSeed'
  >
}

/** The journal entry an `audiocpp_server` gets the moment it starts, so a crashed owner's successor can reap it. */
export function audioJournal(
  journal: Pick<ProcessJournal, 'add' | 'remove'>,
  instanceId: string,
  now: () => number = Date.now
): NonNullable<AudioServiceDeps['journal']> {
  return {
    add: async (pid, port, exe, modelId) =>
      journal.add({
        instance_id: instanceId,
        pid,
        process_start_id: (await processStartId(pid)) ?? null,
        exe,
        provider: AUDIO_PROVIDER,
        model_id: modelId,
        port,
        started_at: new Date(now()).toISOString(),
      }),
    remove: (pid) => journal.remove(pid),
  }
}

export function wireAudio(options: WireAudioOptions): AudioService {
  const service = new AudioService({
    paths: options.layout.audio,
    emit: options.emit,
    log: options.log,
    journal: audioJournal(options.journal, options.instanceId),
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.claimGpu ? { claimGpu: options.claimGpu } : {}),
    ...(options.backendOutput ? { backendOutput: options.backendOutput } : {}),
    ...options.overrides,
  })
  service.start()
  return service
}
