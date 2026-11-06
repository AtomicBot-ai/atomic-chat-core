/** One physical generator per session. The next turn starts only when cancellation was acknowledged or the child exited. */
export class GenerationQueue {
  private active = false
  private readonly waiting = new Set<() => void>()
  constructor(
    private readonly capacity: number,
    private readonly confirmStop: () => Promise<void>
  ) {}
  async run(signal: AbortSignal, forward: () => Promise<void>): Promise<boolean> {
    if (signal.aborted) return true
    if (this.active) {
      if (this.waiting.size >= this.capacity) return false
      const acquired = await new Promise<boolean>((resolve) => {
        const cancel = () => {
          this.waiting.delete(grant)
          resolve(false)
        }
        const grant = () => {
          this.waiting.delete(grant)
          signal.removeEventListener('abort', cancel)
          resolve(true)
        }
        this.waiting.add(grant)
        signal.addEventListener('abort', cancel, { once: true })
      })
      if (!acquired) return true
    }
    this.active = true
    let stopped: Promise<void> | undefined
    const cancel = () => {
      stopped = this.confirmStop()
      void stopped.catch(() => {})
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      if (!signal.aborted) await forward()
    } finally {
      signal.removeEventListener('abort', cancel)
      try {
        await stopped
      } finally {
        const next = this.waiting.values().next().value
        if (next) next()
        else this.active = false
      }
    }
    return true
  }
}
