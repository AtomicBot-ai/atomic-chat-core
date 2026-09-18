/**
 * How the owner builds the image-generation service: the child journal adapter (an `sd-server` is
 * journalled like any backend, under `provider: 'diffusion'`, right after it spawns) and the event
 * bus. Kept out of `create.ts`, which stays a list of `await`s.
 */

import type { DataLayout } from '../config/index.js'
import type { CoreEvents } from '../contracts/index.js'
import { processStartId } from '../lock/index.js'
import type { ProcessJournal } from '../lock/index.js'
import { DiffusionService } from './service.js'
import type { DiffusionServiceDeps } from './service.js'

export interface WireDiffusionOptions {
  layout: DataLayout
  journal: Pick<ProcessJournal, 'add' | 'remove'>
  instanceId: string
  emit: <K extends keyof CoreEvents>(name: K, payload: CoreEvents[K]) => void
  log: (level: 'info' | 'warn' | 'debug', msg: string) => void
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Test seams, straight through to the service. */
  overrides?: Pick<
    DiffusionServiceDeps,
    'http' | 'spawn' | 'timings' | 'idleTickMs' | 'now' | 'sleep' | 'drawSeed'
  >
}

/** The journal entry an `sd-server` gets the moment it starts, so a crashed owner's successor can reap it. */
export function diffusionJournal(
  journal: Pick<ProcessJournal, 'add' | 'remove'>,
  instanceId: string,
  now: () => number = Date.now
): NonNullable<DiffusionServiceDeps['journal']> {
  return {
    add: async (pid, port, exe, modelId) =>
      journal.add({
        instance_id: instanceId,
        pid,
        process_start_id: (await processStartId(pid)) ?? null,
        exe,
        provider: 'diffusion',
        model_id: modelId,
        port,
        started_at: new Date(now()).toISOString(),
      }),
    remove: (pid) => journal.remove(pid),
  }
}

export function wireDiffusion(options: WireDiffusionOptions): DiffusionService {
  const service = new DiffusionService({
    paths: options.layout.diffusion,
    dataFolder: options.layout.root,
    emit: options.emit,
    log: options.log,
    journal: diffusionJournal(options.journal, options.instanceId),
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...options.overrides,
  })
  service.start()
  return service
}
