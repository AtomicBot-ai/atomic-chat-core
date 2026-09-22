/**
 * Unload the model after `idleUnloadSecs` without a job. The deadline is re-armed by every job
 * completion and by `touchIdle`. `idle_task` in `lib.rs` of `tauri-plugin-atomic-diffusion` (app
 * commit `767ff6350`): a tick, never a wait behind a load.
 */

import type { AsyncMutex } from './mutex.js'
import type { DiffusionState } from './state.js'

/** How often the idle task checks the deadline. */
export const IDLE_TICK_MS = 30_000

export interface IdleDeps {
  state: DiffusionState
  loadLock: AsyncMutex
  /** Unload the resident session; called with the load lock held. */
  unload: (reason: string) => Promise<void>
  log: (level: 'info' | 'warn', msg: string) => void
  tickMs?: number
}

/** One look at the deadline: whether an unload was started. Exposed for the tests and the service. */
export async function idleTick(deps: IdleDeps): Promise<boolean> {
  const { state } = deps
  if (!state.idleExpired() || state.activeJobId !== undefined) return false
  const release = deps.loadLock.tryAcquire()
  if (!release) return false
  try {
    if (!state.session) {
      state.clearIdle()
      return false
    }
    deps.log('info', 'unloading the image model after idling')
    await deps.unload('idle')
    return true
  } catch (error) {
    deps.log('warn', `idle unload failed: ${error instanceof Error ? error.message : String(error)}`)
    return false
  } finally {
    release()
  }
}

/** Start the ticking; the timer never keeps the process alive. */
export function startIdleTask(deps: IdleDeps): { stop(): void } {
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    void idleTick(deps).finally(() => (running = false))
  }, deps.tickMs ?? IDLE_TICK_MS)
  timer.unref()
  return { stop: () => clearInterval(timer) }
}
