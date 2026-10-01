/**
 * Where `tensorrt-llm` models live, as clients must use it (change `add-tensorrt-llm-windows`, task
 * 2.8, design D6; spec `tensorrt-llm-models` "Core сообщает расположение моделей"). One answer, from
 * core, on every platform, so a client never derives the folder itself: on Linux the data folder's own
 * `<data>/tensorrt-llm/models` as before; on Windows the scope's folder in Atomic Chat's WSL
 * distribution, `\\wsl.localhost\<distribution>\var\lib\atomic-chat\scopes\<scope_key>\models\tensorrt-llm`,
 * created (and handed to uid 1000) before a client writes into it. The free space on Windows is the
 * smaller of the guest's own and the Windows volume's that holds the distribution's disk image: the
 * guest's disk can grow only as far as that volume lets it. Before the distribution exists there is no
 * such folder: `MANAGED_ADAPTER_UNAVAILABLE`, and no download starts.
 */
import { AtomicCoreError } from '../../contracts/index.js'
import type { TensorrtLlmModelLocation } from '../../contracts/index.js'
import { freeBytesAtNearest, parseDfAvail } from '../environment/index.js'
import type { WindowsEnvironmentRecord } from '../environment/index.js'
import {
  ensureGuestScope,
  guestScopeRoot,
  WSL_LOCALHOST_MOUNT,
  type GuestMount,
  type WslDistributionTransport,
} from '../wsl/index.js'

/** Linux: `<data>/tensorrt-llm/models`, with the free space of the volume it is (or will be) on. */
export async function linuxModelLocation(
  root: string,
  freeBytes: (path: string) => Promise<number | null> = freeBytesAtNearest
): Promise<TensorrtLlmModelLocation> {
  return { root, free_bytes: await freeBytes(root).catch(() => null) }
}

export interface WindowsModelLocationDeps {
  records: { read(): Promise<WindowsEnvironmentRecord | null> }
  /** This scope's `scope_key` (`readOrCreateGuestScopeKey`). */
  scopeKey: () => Promise<string>
  transport: (distribution: string) => WslDistributionTransport
  /** Free bytes on the Windows volume holding `path` (`WindowsHost.freeDiskBytes`). */
  volumeFreeBytes: (path: string) => Promise<number | null>
  /** How core reaches the guest's files; `\\wsl.localhost` unless a test says otherwise. */
  mount?: GuestMount
}

/** The guest folder of this scope's `tensorrt-llm` models. */
export function guestModelsRoot(scopeKey: string): string {
  return `${guestScopeRoot(scopeKey)}/models/tensorrt-llm`
}

export async function windowsModelLocation(
  deps: WindowsModelLocationDeps
): Promise<TensorrtLlmModelLocation> {
  const record = await deps.records.read()
  if (record === null) {
    throw new AtomicCoreError(
      'MANAGED_ADAPTER_UNAVAILABLE',
      'TensorRT-LLM models live in Atomic Chat’s WSL distribution, which is not set up yet.'
    )
  }
  const key = await deps.scopeKey()
  const transport = deps.transport(record.distribution.name)
  const guestRoot = guestModelsRoot(key)
  // A distribution unregistered behind the app's back is no environment at all for a client.
  await ensureGuestScope(transport, key).catch((error: unknown) => {
    throw new AtomicCoreError(
      'MANAGED_ADAPTER_UNAVAILABLE',
      'Atomic Chat’s WSL distribution does not answer; set the environment up again.',
      error instanceof Error ? error.message : String(error)
    )
  })
  const [guest, volume] = await Promise.all([
    transport
      .exec(['df', '--output=avail', '-B1', guestRoot], { user: 'root', timeoutMs: 120_000 })
      .then(parseDfAvail)
      .catch(() => null),
    deps.volumeFreeBytes(record.distribution.path).catch(() => null),
  ])
  const known = [guest, volume].filter((value): value is number => value !== null)
  return {
    root: (deps.mount ?? WSL_LOCALHOST_MOUNT).hostPath(record.distribution.name, guestRoot),
    free_bytes: known.length === 0 ? null : Math.min(...known),
  }
}
