/**
 * A Windows scope's own folder in the guest (change `add-tensorrt-llm-windows`, task 2.6, design D5):
 * `scope_key` — a random id core makes once and keeps in the scope's data
 * (`ManagedScopePaths.guestScopeFile`), so that copying the data folder elsewhere keeps pointing at the
 * same guest folder and its models (spec "Перенос папки данных не перемещает модели") — and the folders
 * under it, created as the guest's root and handed to uid 1000: the account the app writes models as
 * through `\\wsl.localhost` and the model container runs as, so the files of both belong to one user.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import { guestScopeRoot } from './guest-paths.js'
import type { WslDistributionTransport } from './transport.js'

const SCOPE_KEY = /^[A-Za-z0-9-]{1,64}$/
/** The account in the guest that owns a scope's files (design D5). */
export const GUEST_SCOPE_OWNER = '1000:1000'

/** The scope's key, made on first use. A file that does not hold a valid key is an error, never replaced. */
export async function readOrCreateGuestScopeKey(
  file: string,
  newKey: () => string = randomUUID
): Promise<string> {
  let text: string | null = null
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (text !== null) {
    const parsed = JSON.parse(text) as { schema_version?: unknown; scope_key?: unknown }
    if (
      parsed.schema_version !== 1 ||
      typeof parsed.scope_key !== 'string' ||
      !SCOPE_KEY.test(parsed.scope_key)
    ) {
      throw new AtomicCoreError('MANAGED_METADATA_INVALID', 'The guest scope key file is not valid.', file)
    }
    return parsed.scope_key
  }
  const key = newKey()
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  await writeFile(temp, `${JSON.stringify({ schema_version: 1, scope_key: key })}\n`, 'utf8')
  await rename(temp, file)
  return key
}

/** One read (or creation) of the key shared by every caller: two first callers racing would each create one. */
export function guestScopeKeyReader(file: string, newKey: () => string = randomUUID): () => Promise<string> {
  let read: Promise<string> | null = null
  return () => {
    read ??= readOrCreateGuestScopeKey(file, newKey).catch((error: unknown) => {
      read = null
      throw error
    })
    return read
  }
}

/**
 * `managed-models`, `models/tensorrt-llm`, `caches`, `heartbeats`, `watchdog` under the scope's guest root,
 * owned by uid 1000 — and the folders directly in `managed-models` too: the store migration creates a
 * moved model's parent (`managed-models/<org>`) as root, and a folder root owns there refuses every
 * later download into it through `\\wsl.localhost` (`EACCES`, Windows `os error 5`).
 */
export async function ensureGuestScope(transport: WslDistributionTransport, scopeKey: string): Promise<void> {
  const root = guestScopeRoot(scopeKey)
  const store = `${root}/managed-models`
  const leaves = [
    store,
    `${root}/models/tensorrt-llm`,
    `${root}/caches`,
    `${root}/heartbeats`,
    `${root}/watchdog`,
  ]
  const run = async (argv: string[]): Promise<void> => {
    const output = await transport.exec(argv, { user: 'root', timeoutMs: 120_000 })
    if (output.code !== 0) {
      throw new AtomicCoreError(
        'IO_ERROR',
        `The model folders could not be prepared in the distribution "${transport.name}".`,
        `${argv.join(' ')}: ${output.stderr.trim()}`
      )
    }
  }
  await run(['mkdir', '-p', ...leaves])
  // Not recursive: the folders, never every file of every model under them.
  await run(['chown', GUEST_SCOPE_OWNER, root, `${root}/models`, ...leaves])
  // Only folders root owns, one level down: the model folders below them already belong to uid 1000.
  await run([
    'find',
    store,
    '-mindepth',
    '1',
    '-maxdepth',
    '1',
    '-type',
    'd',
    '-user',
    'root',
    '-exec',
    'chown',
    GUEST_SCOPE_OWNER,
    '{}',
    '+',
  ])
}
