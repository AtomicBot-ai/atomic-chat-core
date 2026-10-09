/**
 * Starting the first installed engine build that runs, for the decision and the embedding module: both
 * resolve a build through their engine gate, spawn it, and hand a build that will not run back to the
 * gate (`reject`) so the next resolve skips it.
 *
 * A build will not run when readiness refused it as unsupported (`unsupportedCode`: an API version this
 * core does not speak), or when it died before it was ready (`MODEL_LOAD_FAILED`: it crashed while
 * loading, or could not be spawned). The second is a build matter as often as the first: a ROCm build
 * whose rocBLAS has no kernels for the card's gfx target loads the model and dies on its first matrix
 * product (`hipErrorInvalidKernelFile`), while the Vulkan build of the same release runs. A start used
 * to stop at that crash with the Vulkan build never tried.
 *
 * An explicit engine path has nothing to fall back to. When a build crashed and no other is left, the
 * start fails with that crash and its output, not with "no build can run the model", which would hide
 * why; the gate's list of every build it tried goes along in the details.
 */

import { AtomicCoreError } from '../contracts/index.js'

/** Builds a start may skip, before it gives up. */
export const MAX_ENGINE_ATTEMPTS = 8

export interface EngineFallbackOptions<E extends { path: string }, H> {
  /** `decision` or `embedding`, for the log. */
  label: string
  /** The gate's answer: the next build to try. Throws `unsupportedCode` when none is left. */
  resolve: () => Promise<E>
  /** Called with every resolved build, before it is started. */
  onEngine: (engine: E) => void
  /** Throws when the start was stopped meanwhile. */
  throwIfStopped: () => void
  spawn: (engine: E) => Promise<H>
  /** The module's "this build cannot run the model" code. */
  unsupportedCode: string
  /** An engine path the settings name: refusals end the start. */
  explicit: boolean
  /** Skip `exe` from now on (the gate's `reject`); absent, nothing falls back. */
  reject?: (exe: string, why: string) => Promise<void>
  log: (level: 'warn', msg: string) => void
}

export async function spawnOnFirstGoodEngine<E extends { path: string }, H>(
  options: EngineFallbackOptions<E, H>
): Promise<H> {
  let crash: AtomicCoreError | undefined
  for (let attempt = 1; ; attempt++) {
    let engine: E
    try {
      engine = await options.resolve()
    } catch (error) {
      if (crash !== undefined && error instanceof AtomicCoreError && error.code === options.unsupportedCode)
        throw new AtomicCoreError(
          crash.code,
          crash.message,
          [error.details, crash.details].filter((part) => part !== undefined && part !== '').join('\n\n') ||
            undefined
        )
      throw error
    }
    options.onEngine(engine)
    options.throwIfStopped()
    try {
      return await options.spawn(engine)
    } catch (error) {
      const refused = error instanceof AtomicCoreError && error.code === options.unsupportedCode
      const died = error instanceof AtomicCoreError && error.code === 'MODEL_LOAD_FAILED'
      const fallback =
        (refused || died) &&
        !options.explicit &&
        options.reject !== undefined &&
        attempt < MAX_ENGINE_ATTEMPTS
      if (!fallback) throw error
      const failure = error as AtomicCoreError
      // A crash's own output stays with the crash; the gate keeps one line for its list.
      const why = died ? failure.message : (failure.details ?? failure.message)
      if (died) crash = failure
      options.log(
        'warn',
        `${options.label} engine ${engine.path} ${died ? 'failed to start' : 'refused at readiness'}, trying the next: ${why}`
      )
      await options.reject?.(engine.path, why)
    }
  }
}
