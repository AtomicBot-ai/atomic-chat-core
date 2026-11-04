/**
 * Renames and removals of files this process has just written, retried while Windows holds them.
 *
 * On Windows a file that was written a moment ago is often still open in another process: real-time
 * antivirus scanning it, the search indexer, a `llama-server` that has only just exited. Until that
 * handle closes, renaming or deleting the file (or a directory holding it) fails with
 * `ERROR_ACCESS_DENIED` / `ERROR_SHARING_VIOLATION` (os error 5 / 32 / 33), which libuv reports as
 * `EPERM`, `EBUSY` or `EACCES`, and a directory still holding a file pending deletion as `ENOTEMPTY`.
 * The hold lasts seconds. Elsewhere those codes mean what they say, so only Windows waits.
 */

/** Codes a held handle produces on Windows. */
export const TRANSIENT_FS_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'])

/** The waits between attempts on Windows: eight attempts over ten seconds, the longest waits last. */
export const FS_RETRY_DELAYS_MS: readonly number[] = [100, 250, 500, 1_000, 2_000, 3_000, 3_150]

export interface FsRetryOptions {
  /** Retries happen on `win32` only. */
  platform?: NodeJS.Platform | string
  delaysMs?: readonly number[]
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Whether `error` is one a held handle produces on Windows. */
export function isTransientFsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' && TRANSIENT_FS_CODES.has(code)
}

/**
 * Run `op`, and on Windows run it again after a growing wait while it fails with a held-handle code.
 * The last failure is rethrown unchanged; any other failure is rethrown at once.
 */
export async function retryTransientFs<T>(op: () => Promise<T>, options: FsRetryOptions = {}): Promise<T> {
  const delays =
    (options.platform ?? process.platform) === 'win32' ? (options.delaysMs ?? FS_RETRY_DELAYS_MS) : []
  const sleep = options.sleep ?? defaultSleep
  for (let attempt = 0; ; attempt++) {
    try {
      return await op()
    } catch (error) {
      const delay = delays[attempt]
      if (delay === undefined || !isTransientFsError(error)) throw error
      await sleep(delay)
    }
  }
}
