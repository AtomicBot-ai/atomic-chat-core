/**
 * A lock for work that must not interleave: one load or unload at a time, one reader-writer of the
 * gallery's flags file at a time. Fair (first come, first served), and a holder that throws still
 * lets the next one in.
 */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve()

  /** Wait for the lock; the returned function gives it back (calling it twice is harmless). */
  async acquire(): Promise<() => void> {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const previous = this.tail
    this.tail = previous.then(() => held)
    await previous
    return release
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
