/**
 * One thing at a time, in arrival order: the hosts' generation queue (LiteRT-LM task 5.5, GenieX
 * task 5.5). A failure of the thing running does not block the next one.
 */
export class FifoLock {
  private tail: Promise<unknown> = Promise.resolve()
  /** Work queued behind the one running, that one included. */
  waiting = 0

  run<T>(fn: () => Promise<T>): Promise<T> {
    this.waiting++
    const run = this.tail.then(fn)
    const settled = run.then(
      () => {
        this.waiting--
      },
      () => {
        this.waiting--
      }
    )
    this.tail = settled
    return run
  }
}
