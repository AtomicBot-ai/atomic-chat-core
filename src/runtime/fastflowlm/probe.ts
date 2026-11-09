import type { FastFlowLmAccelerators } from '../../contracts/index.js'
import type { AsyncMutex } from '../../diffusion/index.js'

/** Read-only callers share the hardware inspection while it is in flight. */
export function createFlmProbe(lock: AsyncMutex, inspect: () => Promise<FastFlowLmAccelerators>) {
  let pending: Promise<FastFlowLmAccelerators> | undefined
  return () => {
    pending ??= lock.run(inspect).finally(() => {
      pending = undefined
    })
    return pending
  }
}
