/**
 * `AtomicCore` facade — the one object consumers hold. PLAN.md §3.3.
 *
 * Phase 0 ships the skeleton only; services are wired in as their modules land:
 *   config → events → settings → credentials → hardware → downloads → backend → models →
 *   speculative → runtime → cloud → router → server → lock.
 */

import { CORE_VERSION } from './version.js'

export { CORE_VERSION }

export interface AtomicCoreOptions {
  /** Explicit data folder; otherwise resolved like the app does (PLAN.md §8.2 "Папка данных"). */
  dataFolder?: string
  /** Where the app's bundled sidecar binaries live (`resources/bin`); needed for MLX and Foundation Models. */
  resourcesDir?: string
  fetch?: typeof fetch
  env?: NodeJS.ProcessEnv
  /** 'owner' takes the instance lock; 'auto' falls back to client mode when an owner is running. */
  role?: 'owner' | 'auto'
}

export class AtomicCore {
  readonly version = CORE_VERSION
  readonly options: Readonly<AtomicCoreOptions>

  private constructor(options: AtomicCoreOptions) {
    this.options = Object.freeze({ ...options })
  }

  static async create(options: AtomicCoreOptions = {}): Promise<AtomicCore> {
    return new AtomicCore(options)
  }

  async dispose(): Promise<void> {
    // unloadAll → server.stop → release lock, once those modules exist.
  }
}
