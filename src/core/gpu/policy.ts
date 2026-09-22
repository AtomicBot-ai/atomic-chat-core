/**
 * Who may hold the GPU. One rule: one resident local model per device.
 *
 * Every local engine already unloads its own models before loading another, but none of them knows
 * about the others — llama.cpp does not know MLX is resident, and neither knows a container is.
 * Adding a fourth engine that takes an entire card makes that gap a user-visible failure, so the
 * decision moves here, where every local load passes through one table.
 *
 * The rule is deliberately blunt: loading a model stops whatever else holds the device, generating
 * or not. A caller that is mid-answer gets the ordinary connection error. The alternative — keeping
 * an activity count so a busy model cannot be evicted — costs a proxy in front of every local
 * request, and switching models is something the user just asked for.
 *
 * What is not blunt is the release. A reservation is held until something *verified* says the
 * process or container is gone: an unload that timed out, an HTTP connection that dropped, or a
 * killed Docker client are not evidence, and treating them as such hands the next load a device
 * whose memory is still occupied.
 */

import { err, ok, type Result } from '../../util/index.js'

/**
 * What identifies one loaded model. The provider is part of it: two engines can hold the same
 * model id, and a PID or a file name identifies neither.
 */
export interface SessionKey {
  scope_id: string
  provider: string
  model_id: string
  /** Changes every time the model is loaded again, so a stale caller cannot address the new one. */
  generation: string
}

export interface Reservation {
  reservation_id: string
  session: SessionKey
  gpu_id: string
}

/**
 * Evidence that a reservation may be released. `not-started` is the only one that is not about a
 * process ending, and it is accepted only before anything was started — a spawn that failed leaves
 * nothing behind to observe.
 *
 * The container variant records what the executor observed through the engine that owns the
 * container; T06a's `StopEvidence` is what the managed-text lifecycle turns into this. The policy
 * checks that a verified observation exists and that it names this execution, not the executor's
 * internals.
 */
export type StopProof =
  | { kind: 'container'; execution_id: string; observed: 'exited' | 'absent' }
  | { kind: 'native'; host_pid: number; process_identity: string; verified_exited: true }
  | { kind: 'not-started'; reservation_id: string }

interface Resident {
  reservation_id: string
  session: SessionKey
  gpu_id: string
  started: boolean
  execution_id: string | null
}

export interface ResidencyOptions {
  /** Supplied rather than generated here, so the table is a pure function of its inputs. */
  newReservationId: () => string
}

const sameSession = (a: SessionKey, b: SessionKey): boolean =>
  a.scope_id === b.scope_id &&
  a.provider === b.provider &&
  a.model_id === b.model_id &&
  a.generation === b.generation

/** The same model on the same engine, loaded again: same slot, different generation. */
const sameSlot = (a: SessionKey, b: SessionKey): boolean =>
  a.scope_id === b.scope_id && a.provider === b.provider && a.model_id === b.model_id

const describe = (session: SessionKey): string => `${session.provider}/${session.model_id}`

export class ResidencyPolicy {
  private readonly residents = new Map<string, Resident>()
  private readonly newReservationId: () => string

  constructor(options: ResidencyOptions) {
    this.newReservationId = options.newReservationId
  }

  /**
   * What must stop before `session` can have `gpu_id`. Empty when the device is free or already
   * held by this very session. A model that is answering a request right now is listed like any
   * other: the caller asked to load something else.
   *
   * A session that never reserved — anything running on the CPU — is not here to be listed.
   */
  evictionsFor(session: SessionKey, gpuId: string): SessionKey[] {
    const resident = this.residents.get(gpuId)
    if (resident === undefined || sameSession(resident.session, session)) return []
    return [resident.session]
  }

  /** Take the device. Busy while anyone else holds it, including a stop that is not confirmed. */
  reserve(session: SessionKey, gpuId: string): Result<Reservation> {
    const resident = this.residents.get(gpuId)
    if (resident !== undefined) {
      if (sameSession(resident.session, session)) {
        // Asking twice for what you already hold is an answer, not an error.
        return ok({
          reservation_id: resident.reservation_id,
          session: resident.session,
          gpu_id: resident.gpu_id,
        })
      }
      return err(
        'GPU_BUSY',
        `${describe(resident.session)} is loaded on this GPU.`,
        `gpu=${gpuId} holder=${describe(resident.session)}`
      )
    }
    const reservation: Reservation = {
      reservation_id: this.newReservationId(),
      session,
      gpu_id: gpuId,
    }
    this.residents.set(gpuId, {
      reservation_id: reservation.reservation_id,
      session,
      gpu_id: gpuId,
      started: false,
      execution_id: null,
    })
    return ok(reservation)
  }

  /** A process or container now exists, so only observed exit can release the device. */
  markStarted(reservation: Reservation, executionId: string): Result<void> {
    const resident = this.find(reservation)
    if (!resident.ok) return err(resident.error.code, resident.error.message, resident.error.details)
    const found = resident.value
    if (found.started && found.execution_id !== executionId) {
      return err(
        'MANAGED_IDENTITY_MISMATCH',
        'This reservation already started something else.',
        `have=${found.execution_id ?? 'none'} got=${executionId}`
      )
    }
    found.started = true
    found.execution_id = executionId
    return ok(undefined)
  }

  /** Release the device, but only on evidence that what was started is gone. */
  confirmStopped(reservation: Reservation, proof: StopProof): Result<void> {
    const resident = this.residents.get(reservation.gpu_id)
    if (resident === undefined || resident.reservation_id !== reservation.reservation_id) {
      // A confirmation for a reservation nobody holds is either a duplicate — harmless, the device
      // is already free of it — or a caller that has not noticed the model was loaded again.
      const replaced = [...this.residents.values()].some(
        (other) =>
          sameSlot(other.session, reservation.session) &&
          other.session.generation !== reservation.session.generation
      )
      return replaced
        ? err(
            'SESSION_GENERATION_STALE',
            'That model has been loaded again since this reservation.',
            `reservation=${reservation.reservation_id}`
          )
        : ok(undefined)
    }
    if (!sameSession(resident.session, reservation.session)) {
      return err(
        'MANAGED_IDENTITY_MISMATCH',
        'This reservation does not name the session holding the GPU.',
        `holder=${describe(resident.session)}`
      )
    }
    if (proof.kind === 'not-started') {
      if (resident.started) {
        return err(
          'MANAGED_STOP_UNCONFIRMED',
          'Something was started for this reservation, so its exit has to be observed.',
          `execution=${resident.execution_id ?? 'unknown'}`
        )
      }
      if (proof.reservation_id !== reservation.reservation_id) {
        return err('MANAGED_IDENTITY_MISMATCH', 'This proof names another reservation.')
      }
    }
    if (proof.kind === 'container' && resident.execution_id !== null) {
      if (proof.execution_id !== resident.execution_id) {
        return err(
          'MANAGED_IDENTITY_MISMATCH',
          'This proof names another container.',
          `holder=${resident.execution_id}`
        )
      }
    }
    this.residents.delete(reservation.gpu_id)
    return ok(undefined)
  }

  /** Who holds each device, for a snapshot or a diagnostic. */
  list(): { gpu_id: string; session: SessionKey; started: boolean }[] {
    return [...this.residents.values()].map((resident) => ({
      gpu_id: resident.gpu_id,
      session: resident.session,
      started: resident.started,
    }))
  }

  private find(reservation: Reservation): Result<Resident> {
    const resident = this.residents.get(reservation.gpu_id)
    if (resident === undefined || resident.reservation_id !== reservation.reservation_id) {
      return err('SESSION_GENERATION_STALE', 'This reservation no longer holds the GPU.')
    }
    if (!sameSession(resident.session, reservation.session)) {
      return err('MANAGED_IDENTITY_MISMATCH', 'This reservation does not name the session holding the GPU.')
    }
    return ok(resident)
  }
}
