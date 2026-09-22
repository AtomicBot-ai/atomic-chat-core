/**
 * A lock for work that must not interleave: one load or unload at a time, one reader-writer of the
 * gallery's flags file at a time. Fair (first come, first served), and a holder that throws still
 * lets the next one in. `tryAcquire` is for the idle timer, which must never wait behind a load.
 */
export class AsyncMutex {
  private held = false
  private readonly waiters: Array<(release: () => void) => void> = []

  private grant(): () => void {
    this.held = true
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiters.shift()
      if (next) next(this.grant())
      else this.held = false
    }
  }

  get locked(): boolean {
    return this.held
  }

  /** Wait for the lock; the returned function gives it back (calling it twice is harmless). */
  acquire(): Promise<() => void> {
    if (!this.held) return Promise.resolve(this.grant())
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  /** The lock at once, or `undefined` when someone holds it. */
  tryAcquire(): (() => void) | undefined {
    return this.held ? undefined : this.grant()
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    const release = await this.acquire()
    try {
      return await work()
    } finally {
      release()
    }
  }
}
