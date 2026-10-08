/**
 * Runs the residency rule (`policy.ts`) for one core: every runtime's claim hook lands here, before
 * the runtime starts anything on a GPU. What to stop comes from the pure policy over what the engines
 * report; how to stop each one — and to wait for its confirmed exit — is the `evict` the core's
 * wiring (`create.ts`) attaches to each occupant.
 *
 * GPU claims are taken one at a time. A load becomes an occupant only once its claim has succeeded
 * (the runtimes report it `loading` from then on), so of two loads racing for a card the later claim
 * sees the earlier one and stops it: the model the user asked for last is the one that stays. A claim
 * that is cancelled while it waits gives up its turn without touching anything.
 *
 * A claim that cannot free its card is refused with `GPU_BUSY` naming what still holds it: an
 * eviction that rejected, or "succeeded" while its session is still listed (a `stop-unconfirmed`
 * container, a process that would not die), leaves the card reserved, and the next claim tries to
 * stop it again. A session that reports `busy` (an image or video job) is never stopped: the claim is
 * refused before anything is, and is asked again right before each stop, since a job can start while
 * an earlier stop is awaited.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import { raceLoadCancel, throwIfLoadCancelled } from '../../runtime/index.js'
import type { GpuClaimHook } from '../../runtime/index.js'
import { busyHolder, claimsGpu, gpuBusyError, gpuEvictions, gpuWorkingError } from './policy.js'
import type { GpuOccupant, GpuRequest } from './policy.js'

/** An occupant with the one way to stop it: resolves once its exit is confirmed. */
export interface ResidencyOccupant extends GpuOccupant {
  evict: () => Promise<void>
}

export interface GpuResidencyDeps {
  /** Every session of this core that holds, or is about to hold, a GPU — read fresh at every step. */
  occupants: () => ResidencyOccupant[]
}

const key = (occupant: GpuOccupant): string => `${occupant.provider}\0${occupant.model_id}`

/** Why an eviction failed, with the engine's own details (Docker's answer, the container id) when it has them. */
const reason = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error)
  const details = error instanceof AtomicCoreError ? error.details : undefined
  return details === undefined ? error.message : `${error.message} (${details})`
}

export class GpuResidency {
  /** The end of the queue of GPU claims: each one waits for the claim before it. */
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly deps: GpuResidencyDeps) {}

  /** The claim hook one provider's runtime is given. */
  hook(provider: string): GpuClaimHook {
    return (claim, signal, granted) => this.claim({ ...claim, provider }, signal, granted)
  }

  /**
   * `granted` runs synchronously once the claim has succeeded, still inside this claim's turn: the
   * runtime registers its load there, so the next claim — which cannot start before this turn ends —
   * always finds it.
   */
  async claim(request: GpuRequest, signal?: AbortSignal, granted?: () => void): Promise<void> {
    throwIfLoadCancelled(signal)
    // Outside the rule both ways: it neither evicts nor waits for anyone to be evicted.
    if (!claimsGpu(request)) {
      granted?.()
      return
    }
    const release = await this.turn(signal)
    try {
      const causes = new Map<string, string>()
      const evictions = gpuEvictions(request, this.deps.occupants())
      // All or nothing: a refusal over a busy session leaves every other one where it was.
      const working = busyHolder(evictions)
      if (working?.busy !== undefined) throw gpuWorkingError(working, working.busy)
      for (const occupant of evictions) {
        throwIfLoadCancelled(signal)
        const now = this.deps.occupants().find((current) => key(current) === key(occupant))
        if (now?.busy !== undefined) throw gpuWorkingError(now, now.busy)
        // A load cancelled while it waits for a stop stops waiting; the stop itself goes on.
        const stopped = occupant.evict().catch((error: unknown) => {
          causes.set(key(occupant), reason(error))
        })
        await raceLoadCancel(stopped, signal)
      }
      throwIfLoadCancelled(signal)
      const [holder] = gpuEvictions(request, this.deps.occupants())
      if (holder !== undefined)
        throw holder.busy !== undefined
          ? gpuWorkingError(holder, holder.busy)
          : gpuBusyError(holder, causes.get(key(holder)))
      granted?.()
    } finally {
      release()
    }
  }

  /** Waits for the claims ahead; a cancel ends the wait, and the turn is handed on untouched. */
  private async turn(signal?: AbortSignal): Promise<() => void> {
    const ahead = this.tail
    let release!: () => void
    const mine = new Promise<void>((resolve) => (release = resolve))
    this.tail = ahead.then(() => mine)
    try {
      await raceLoadCancel(ahead, signal)
      throwIfLoadCancelled(signal)
    } catch (error) {
      void ahead.then(release)
      throw error
    }
    return release
  }
}
