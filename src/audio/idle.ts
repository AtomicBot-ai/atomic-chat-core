/**
 * Unload the audio model after `idleUnloadSecs` without a job. The deadline is re-armed by every job
 * that ends and by `touchIdle`. A tick, never a wait behind a load (image generation's `idle.ts`).
 */

import type { AsyncMutex } from '../diffusion/index.js'
import type { AudioState } from './state.js'

/** How often the idle task checks the deadline. */
export const IDLE_TICK_MS = 30_000

export interface AudioIdleDeps {
  state: AudioState
  loadLock: AsyncMutex
  /** Unload the resident model; called with the load lock held. */
  unload: (reason: string) => Promise<void>
  log: (level: 'info' | 'warn', msg: string) => void
  tickMs?: number
}

/** One look at the deadline: whether an unload was started. */
export async function audioIdleTick(deps: AudioIdleDeps): Promise<boolean> {
  const { state } = deps
  if (!state.idleExpired() || state.activeJobId !== undefined) return false
  const release = deps.loadLock.tryAcquire()
  if (!release) return false
  try {
    if (!state.spec) {
      state.clearIdle()
      return false
    }
    deps.log('info', 'unloading the audio model after idling')
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
export function startAudioIdleTask(deps: AudioIdleDeps): { stop(): void } {
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    void audioIdleTick(deps).finally(() => (running = false))
  }, deps.tickMs ?? IDLE_TICK_MS)
  timer.unref()
  return { stop: () => clearInterval(timer) }
}
