/**
 * The files of `tensorrt-llm` models and engine caches on Windows (change `add-tensorrt-llm-windows`,
 * task 2.8, design D5): they live in the WSL guest's ext4, and core sees them through
 * `\\wsl.localhost`. Listing and reading a `model.yml` through that path is fine; sizing or deleting
 * tens of gigabytes through it is not — thousands of 9p round trips for what `du` and `rm` do in the
 * guest at once. So sizes and removals run as commands in the guest, as root, with the guest paths
 * behind the UNC ones (`guestPathFor`, which refuses anything outside the distribution). One `du`
 * call for every path counts a hard-linked file once, as the Linux walk does.
 */
import { AtomicCoreError } from '../../contracts/index.js'
import { WSL_LOCALHOST_MOUNT, type GuestMount, type WslDistributionTransport } from '../wsl/index.js'

/** Sizing and removing model and cache folders; the Linux default walks the file system itself. */
export interface ModelFileOps {
  /** Bytes under each path; a path that is not there is 0. */
  sizes(paths: string[]): Promise<Map<string, number>>
  remove(paths: string[]): Promise<void>
}

const TIMEOUT_MS = 30 * 60_000

export function guestModelFiles(
  transport: WslDistributionTransport,
  mount: GuestMount = WSL_LOCALHOST_MOUNT
): ModelFileOps {
  const toGuest = (paths: string[]): string[] => paths.map((path) => mount.guestPath(transport.name, path))
  return {
    sizes: async (paths) => {
      const sizes = new Map<string, number>(paths.map((path) => [path, 0]))
      if (paths.length === 0) return sizes
      const guest = toGuest(paths)
      const answer = await transport.exec(['du', '-s', '-b', '--', ...guest], {
        user: 'root',
        timeoutMs: TIMEOUT_MS,
      })
      // `du` exits 1 when one path is missing, and still prints every other.
      for (const line of answer.stdout.split('\n')) {
        const match = /^(\d+)\t(.+)$/.exec(line)
        if (match === null) continue
        const index = guest.indexOf(match[2] as string)
        if (index !== -1) sizes.set(paths[index] as string, Number(match[1]))
      }
      return sizes
    },
    remove: async (paths) => {
      if (paths.length === 0) return
      const answer = await transport.exec(['rm', '-rf', '--', ...toGuest(paths)], {
        user: 'root',
        timeoutMs: TIMEOUT_MS,
      })
      if (answer.code !== 0) {
        throw new AtomicCoreError(
          'IO_ERROR',
          'The files could not be removed in the Atomic Chat distribution.',
          answer.stderr.trim()
        )
      }
    },
  }
}
