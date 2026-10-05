/**
 * One child process's output stream, bounded (moved here from `container/exec.ts` so the WSL
 * transport bounds what a guest command prints the same way the docker executor does; change
 * `add-tensorrt-llm-windows`, task 2.2).
 */

/**
 * One output stream, bounded to `limit` bytes: the first half as it arrives, then a sliding window
 * over the last half. A log longer than the cap keeps the whole lines of its start and its end, where
 * a decisive last line sits (review of the whole-log read: head-only kept the start and lost the end).
 */
export class HeadAndTail {
  private readonly headLimit: number
  private readonly tailLimit: number
  private readonly head: Buffer[] = []
  private headBytes = 0
  private tail: Buffer[] = []
  private tailBytes = 0
  private dropped = false

  constructor(limit: number) {
    this.headLimit = Math.ceil(limit / 2)
    this.tailLimit = limit - this.headLimit
  }

  push(chunk: Buffer): void {
    const room = this.headLimit - this.headBytes
    if (room > 0) {
      const take = chunk.subarray(0, room)
      this.head.push(take)
      this.headBytes += take.length
      chunk = chunk.subarray(take.length)
    }
    if (chunk.length === 0) return
    this.tail.push(chunk)
    this.tailBytes += chunk.length
    while (this.tail.length > 1 && this.tailBytes - (this.tail[0] as Buffer).length >= this.tailLimit) {
      this.tailBytes -= (this.tail.shift() as Buffer).length
      this.dropped = true
    }
  }

  text(): string {
    return this.bytes().toString('utf8')
  }

  /** What was kept, as bytes — for a caller whose output is not always UTF-8 (`wsl.exe`'s own is UTF-16). */
  bytes(): Buffer {
    let head = Buffer.concat(this.head)
    let tail = Buffer.concat(this.tail)
    if (tail.length > this.tailLimit) {
      tail = tail.subarray(tail.length - this.tailLimit)
      this.dropped = true
    }
    if (!this.dropped) return Buffer.concat([head, tail])
    // Something in the middle was dropped: cut both halves at line boundaries, so every line kept is
    // whole. `docker logs --timestamps` output is merged across stdout and stderr by each line's
    // leading timestamp (`operations.ts`), and a fragment with no timestamp would sort out of place.
    const headEnd = head.lastIndexOf(0x0a)
    head = headEnd === -1 ? Buffer.alloc(0) : head.subarray(0, headEnd + 1)
    const tailStart = tail.indexOf(0x0a)
    tail = tailStart === -1 ? Buffer.alloc(0) : tail.subarray(tailStart + 1)
    return Buffer.concat([head, tail])
  }
}
