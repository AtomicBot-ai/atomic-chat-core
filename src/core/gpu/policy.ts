/**
 * Who may hold a GPU (spec `gpu-residency`, design D10). One rule: one resident local model per card.
 *
 * Every local engine already unloads its own models before loading another, but none of them knows
 * about the others — llama.cpp does not know MLX is resident, and neither knows a container is. A
 * fourth engine that takes an entire card makes that gap a user-visible failure, so the decision is
 * made here, over what every engine reports it holds (`GpuOccupancy`, `runtime/shared`).
 *
 * The rule is deliberately blunt: loading a model stops whatever else holds its card, generating or
 * not. A caller that is mid-answer gets the ordinary connection error. The alternative — an activity
 * count so a busy model cannot be evicted — costs a proxy in front of every local request, and
 * switching models is something the user just asked for.
 *
 * Which card a session holds is the engine's own claim: llama.cpp and MLX chat and diffusion spread
 * a model over every card, so they hold all of them; `tensorrt-llm` holds the one it was started on;
 * a CPU-only session holds none. Embedding and transcription sessions are outside the rule both ways
 * — never evicted, never evicting — or warming an embedding model for RAG would unload a
 * `tensorrt-llm` model the next reply loads again for minutes, forever. Sessions of the requesting
 * provider are its own business (its auto-unload setting), except where the provider runs only one.
 *
 * What is not blunt is the release, and that is not decided here but by what the engines report: a
 * session stays listed — `stopping`, `stop-unconfirmed` — until something verified says its process
 * or container is gone. There is no ledger of reservations to drift from the truth; the engines'
 * own tables are the reservations.
 *
 * Pure: no I/O, no clock. `residency.ts` runs it and does the stopping.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import type { GpuCards, GpuClaim, GpuOccupancy } from '../../runtime/index.js'

/** One session of this core on the GPU, with the provider that runs it. */
export interface GpuOccupant extends GpuOccupancy {
  provider: string
}

/** A load about to start, with the provider that asks. */
export interface GpuRequest extends GpuClaim {
  provider: string
}

const isCpuOnly = (cards: GpuCards): boolean => cards !== 'all' && cards.length === 0

/** Whether two sessions would share a card. A CPU-only side shares nothing. */
export function cardsOverlap(a: GpuCards, b: GpuCards): boolean {
  if (isCpuOnly(a) || isCpuOnly(b)) return false
  if (a === 'all' || b === 'all') return true
  return a.some((card) => b.includes(card))
}

/**
 * Whether a load takes part in the rule at all: an embedding or transcription load, or a CPU-only one,
 * neither evicts anything nor waits for anything to be evicted.
 */
export function claimsGpu(request: GpuRequest): boolean {
  if (request.auxiliary) return false
  return request.soleSessionOfProvider === true || !isCpuOnly(request.cards)
}

/**
 * What must be stopped, with a confirmed exit, before `request` may start. A session answering a
 * request right now is listed like an idle one; so is one whose stop nobody could confirm, since it
 * still holds its card — stopping it again is the only way that card is ever freed.
 */
export function gpuEvictions<T extends GpuOccupant>(request: GpuRequest, occupants: readonly T[]): T[] {
  if (!claimsGpu(request)) return []
  return occupants.filter((occupant) => {
    if (occupant.auxiliary) return false
    if (occupant.provider === request.provider) {
      if (occupant.model_id === request.model_id) return false
      return request.soleSessionOfProvider === true
    }
    return cardsOverlap(request.cards, occupant.cards)
  })
}

const describeCards = (cards: GpuCards): string => (cards === 'all' ? 'all' : cards.join(','))

/** The refusal of a load whose card `holder` still occupies after an attempt to stop it. */
export function gpuBusyError(holder: GpuOccupant, cause?: string): AtomicCoreError {
  const id = `${holder.provider}/${holder.model_id}`
  return new AtomicCoreError(
    'GPU_BUSY',
    `${id} still holds the GPU: its stop has not been confirmed, so nothing else loads there yet.`,
    `holder=${id} state=${holder.state} cards=${describeCards(holder.cards)}` +
      (cause === undefined ? '' : ` cause=${cause}`)
  )
}
