/**
 * Keeping Atomic Chat's distribution running while something needs it (change
 * `add-tensorrt-llm-windows`, task 2.7, design D8; spec "Дистрибутив удерживается, пока он нужен").
 * WSL stops an idle distribution on its own (`instanceIdleTimeout`, 15 s by default), and systemd
 * services do not reliably keep it up (microsoft/WSL#13416); an attached `wsl.exe -d <name> --exec sleep
 * infinity` does. So every user of the distribution — an environment operation, a loading or loaded
 * model, a file operation on models — takes a lease, and one such process runs while any lease is held
 * and none when there is none, so WSL may stop the VM and give its memory back to Windows.
 *
 * When the holding process ends without being released — `wsl --shutdown`, the VM crashed — every
 * subscriber hears of it (a session then ends with `wsl-stopped`), and whoever still holds a lease gets
 * a new hold, which starts the distribution again for them.
 */
import type { WslDistributionTransport, WslHold } from './transport.js'

export interface DistributionLease {
  /** Idempotent. */
  release(): void
}

export interface DistributionKeeper {
  /** Hold the distribution until the lease is released. `reason` only names it for diagnostics. */
  acquire(reason: string): DistributionLease
  /** Whether a holding process is running now. */
  held(): boolean
  /** Called when the distribution stopped under a hold. Returns the unsubscribe. */
  onStopped(listener: () => void): () => void
}

export function createDistributionKeeper(transport: WslDistributionTransport): DistributionKeeper {
  const leases = new Set<symbol>()
  const listeners = new Set<() => void>()
  let hold: WslHold | null = null

  const start = (): void => {
    const current = transport.hold()
    hold = current
    void current.exited.then((end) => {
      if (hold === current) hold = null
      if (end.released) return
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch {
          // One subscriber failing must not keep the others from hearing it.
        }
      }
      // Whoever still needs the distribution gets it back.
      if (leases.size > 0 && hold === null) start()
    })
  }

  return {
    acquire: () => {
      const lease = Symbol('lease')
      leases.add(lease)
      if (hold === null) start()
      return {
        release: () => {
          if (!leases.delete(lease)) return
          if (leases.size === 0 && hold !== null) {
            const current = hold
            hold = null
            current.release()
          }
        },
      }
    },
    held: () => hold !== null,
    onStopped: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
