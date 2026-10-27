/**
 * Undo what earlier Atomic Chat versions wrote into Codex's shared `config.toml`.
 *
 * Until the profile file (`codex.ts`), the Codex writer edited `<codex_home>/config.toml` itself,
 * inside `# >>> Atomic Chat (managed) >>>` … `# <<< Atomic Chat (managed) <<<` regions. V1 (the first
 * Launch page) appended one region: `[model_providers.atomic]` and `[profiles.atomic]`. V2 kept two:
 * root `model` + `model_provider = "atomic"` at the very top, `[model_providers.atomic]` at the end.
 * V2 is the incident: a user with a root `model` of their own got a duplicate key, and Codex — the CLI
 * and the ChatGPT desktop app, which share the file — refused to start until it was fixed by hand.
 *
 * Deleting text from a file that is not ours is safe only for text we can prove is ours, so this is
 * strict where it could be clever. A marker counts only as a whole line; the regions must pair up;
 * each must parse on its own and hold nothing but keys some version wrote, with the values it wrote;
 * the file without them must still parse; and it must not have changed since it was read. Anything
 * else is a conflict: the file stays byte for byte as it was, and the message names it and says which
 * lines to remove by hand. A repair keeps a backup of the original (never over an earlier one) and
 * writes atomically with the file's own permission bits. A `config.toml` that is a symbolic link (a
 * dotfile manager's) is written through: the temp file and the rename happen beside the real file,
 * which gets the new text while the link stays a link; the backup still goes next to the link.
 *
 * The algorithm is shared with the desktop app, which runs it at startup and on disconnect; both
 * sides must reach the same decision on the same bytes
 * (ADR 2026-10-27-codex-runs-on-a-profile-of-its-own).
 */

import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { AtomicCoreError } from '../../contracts/index.js'
import { ATOMIC_MANAGED_BEGIN, ATOMIC_MANAGED_END } from '../config-io.js'
import type { ConfigFs } from '../config-io.js'

/** What the removed regions said, for a caller that wants to carry the setup over to the profile. */
export interface CodexLegacySettings {
  model?: string
  baseUrl?: string
  /** The provider named `ATOMIC_CHAT_API_KEY` as its key variable. */
  keyed: boolean
}

export type CodexRepairResult =
  /** No `config.toml`, or nothing of ours in it. Nothing was written. */
  | { kind: 'clean' }
  | { kind: 'repaired'; backupPath: string; legacy: CodexLegacySettings }
  /** Something we cannot prove is ours. Nothing was written; `reason` is the user-facing message. */
  | { kind: 'conflict'; reason: string }

/** The decision on one file's text, before any I/O: what to write instead, or why not. */
export type CodexRepairPlan =
  | { kind: 'clean' }
  | { kind: 'conflict'; reason: string }
  | { kind: 'repair'; text: string; legacy: CodexLegacySettings }

const ROOT_KEYS = new Set(['model', 'model_provider', 'model_providers', 'profiles'])
const PROVIDER_KEYS = new Set(['name', 'base_url', 'env_key'])
const PROFILE_KEYS = new Set(['model', 'model_provider'])

/** A user's own big integers are valid TOML, not a reason to call their file broken. */
const parseTomlDocument = (text: string) => parseToml(text, { integersAsBigInt: 'asNeeded' })

interface Line {
  /** The line as it is in the file, terminator included. */
  raw: string
  /** Without its `\n` and one `\r` before it. */
  text: string
}

function splitLines(content: string): Line[] {
  const lines: Line[] = []
  for (let start = 0; start < content.length;) {
    const newline = content.indexOf('\n', start)
    const end = newline < 0 ? content.length : newline + 1
    const raw = content.slice(start, end)
    lines.push({ raw, text: raw.replace(/\n$/, '').replace(/\r$/, '') })
    start = end
  }
  return lines
}

const conflict = (path: string, problem: string): { kind: 'conflict'; reason: string } => ({
  kind: 'conflict',
  reason:
    `Atomic Chat cannot remove its old settings from ${path}: ${problem}. ` +
    `Remove the lines between "${ATOMIC_MANAGED_BEGIN}" and "${ATOMIC_MANAGED_END}" by hand, ` +
    'markers included, then connect Codex again.',
})

/** The first line of a parser error, which is the message; the rest is a code frame. */
const parserMessage = (e: unknown): string => String((e as Error).message).split('\n')[0] as string

const isTable = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)

const only = (table: Record<string, unknown>, allowed: Set<string>) =>
  Object.keys(table).every((key) => allowed.has(key))

/** `{ atomic = { … } }` and nothing else beside it. */
function soleAtomicTable(value: unknown): Record<string, unknown> | undefined {
  if (!isTable(value) || Object.keys(value).join() !== 'atomic') return undefined
  const atomic = value['atomic']
  return isTable(atomic) ? atomic : undefined
}

/**
 * The settings in one region when it holds exactly what some Atomic Chat version wrote, else
 * `undefined`. Inline tables and dotted keys mean the same to Codex, so they are accepted too.
 */
export function recogniseLegacyRegion(doc: Record<string, unknown>): CodexLegacySettings | undefined {
  if (Object.keys(doc).length === 0 || !only(doc, ROOT_KEYS)) return undefined
  const found: CodexLegacySettings = { keyed: false }
  const has = (key: string) => Object.hasOwn(doc, key)

  if (has('model')) {
    const model = doc['model']
    if (typeof model !== 'string') return undefined
    found.model = model
  }
  if (has('model_provider') && doc['model_provider'] !== 'atomic') return undefined

  if (has('model_providers')) {
    const provider = soleAtomicTable(doc['model_providers'])
    if (!provider || !only(provider, PROVIDER_KEYS)) return undefined
    const baseUrl = provider['base_url']
    if (provider['name'] !== 'Atomic Chat' || typeof baseUrl !== 'string') return undefined
    const keyed = Object.hasOwn(provider, 'env_key')
    if (keyed && provider['env_key'] !== 'ATOMIC_CHAT_API_KEY') return undefined
    found.baseUrl = baseUrl
    found.keyed = keyed
  }

  if (has('profiles')) {
    const profile = soleAtomicTable(doc['profiles'])
    if (!profile || !only(profile, PROFILE_KEYS)) return undefined
    const model = profile['model']
    if (typeof model !== 'string' || profile['model_provider'] !== 'atomic') return undefined
    found.model ??= model
  }
  return found
}

/**
 * Steps 2–6 of the repair on a file's text: find and pair the marker lines, recognise every region,
 * remove them, and check what is left. Pure, so every rule is testable on a string.
 */
export function planCodexConfigRepair(original: string, path: string): CodexRepairPlan {
  const lines = splitLines(original)

  const markers: Array<{ index: number; begin: boolean }> = []
  for (const [index, { text }] of lines.entries()) {
    if (text === ATOMIC_MANAGED_BEGIN || text === ATOMIC_MANAGED_END) {
      markers.push({ index, begin: text === ATOMIC_MANAGED_BEGIN })
    } else if (text.includes(ATOMIC_MANAGED_BEGIN) || text.includes(ATOMIC_MANAGED_END)) {
      return conflict(path, `line ${index + 1} has an Atomic Chat marker inside other text`)
    }
  }
  if (markers.length === 0) return { kind: 'clean' }

  const regions: Array<{ begin: number; end: number }> = []
  let open: number | undefined
  for (const { index, begin } of markers) {
    if (begin && open !== undefined)
      return conflict(path, `line ${index + 1} opens a block inside the one opened on line ${open + 1}`)
    if (!begin && open === undefined)
      return conflict(path, `line ${index + 1} closes a block that was never opened`)
    if (begin) open = index
    else {
      regions.push({ begin: open as number, end: index })
      open = undefined
    }
  }
  if (open !== undefined) return conflict(path, `the block opened on line ${open + 1} is never closed`)

  const found: CodexLegacySettings[] = []
  for (const [n, { begin, end }] of regions.entries()) {
    const where = `block ${n + 1} (lines ${begin + 1}–${end + 1})`
    let doc: Record<string, unknown>
    try {
      doc = parseTomlDocument(
        lines
          .slice(begin + 1, end)
          .map((line) => line.raw)
          .join('')
      )
    } catch (e) {
      return conflict(path, `${where} is not valid TOML (${parserMessage(e)})`)
    }
    const settings = recogniseLegacyRegion(doc)
    if (!settings) return conflict(path, `${where} has settings Atomic Chat never writes`)
    found.push(settings)
  }
  // V2 split one setup over two regions: the model in the head, the endpoint in the tail.
  const model = found.find((s) => s.model !== undefined)?.model
  const baseUrl = found.find((s) => s.baseUrl !== undefined)?.baseUrl
  const legacy: CodexLegacySettings = {
    ...(model === undefined ? {} : { model }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    keyed: found.some((s) => s.keyed),
  }

  const removed = new Set<number>()
  for (const { begin, end } of regions) for (let index = begin; index <= end; index++) removed.add(index)
  let kept = [...lines.keys()].filter((index) => !removed.has(index))
  // The V2 head was followed by a blank line (or, after reruns, several); at the top of the file
  // they are ours too. A file that did not start with a region keeps its leading lines as they are.
  if (removed.has(0)) {
    const first = kept.findIndex((index) => (lines[index] as Line).text.trim() !== '')
    kept = first < 0 ? [] : kept.slice(first)
  }
  const body = kept
    .map((index) => (lines[index] as Line).raw)
    .join('')
    .trimEnd()
  const text = body === '' ? '' : `${body}\n`

  try {
    parseTomlDocument(text)
  } catch (e) {
    // Report the line as the user sees it in the file now, not in the text we were about to write.
    // `TomlError.line` is 1-based; a message without one (or past the end) names no line.
    const original = kept[(e as { line: number }).line - 1]
    const at = original === undefined ? '' : ` (line ${original + 1})`
    return {
      kind: 'conflict',
      reason:
        `${path} would still not be valid TOML after removing Atomic Chat's settings: ` +
        `${parserMessage(e)}${at}. Fix the file, or remove the lines between "${ATOMIC_MANAGED_BEGIN}" ` +
        `and "${ATOMIC_MANAGED_END}" by hand, markers included, then connect Codex again.`,
    }
  }
  return { kind: 'repair', text, legacy }
}

/** The first free backup name: `config.toml.atomic-chat-backup`, then `-2`, `-3`, … */
export function codexBackupPath(path: string, attempt: number): string {
  return attempt === 1 ? `${path}.atomic-chat-backup` : `${path}.atomic-chat-backup-${attempt}`
}

const readFailure = (path: string, e: unknown) =>
  new AtomicCoreError('IO_ERROR', `Failed to read ${path}`, (e as Error).message)

async function readOrFail(fs: ConfigFs, path: string): Promise<string | undefined> {
  try {
    return await fs.readStrict(path)
  } catch (e) {
    throw readFailure(path, e)
  }
}

/**
 * Remove every legacy Atomic Chat region from `<dir>/config.toml`. Returns a conflict rather than
 * throwing for a file it will not touch; throws only when the file could not be read, backed up or
 * written. Either way a file that was not repaired is exactly as it was.
 */
export async function repairLegacyCodexConfig(
  fs: ConfigFs,
  dir: string,
  platform: NodeJS.Platform
): Promise<CodexRepairResult> {
  const path = join(dir, 'config.toml')
  const original = await readOrFail(fs, path)
  if (original === undefined) return { kind: 'clean' }

  const plan = planCodexConfigRepair(original, path)
  if (plan.kind !== 'repair') return plan

  let target: string
  let mode: number | undefined
  try {
    target = await fs.linkTarget(path)
    mode = platform === 'win32' ? undefined : await fs.permissions(target)
  } catch (e) {
    throw readFailure(path, e)
  }
  // Another program (Codex itself, an editor) may have saved the file while we were deciding.
  if ((await readOrFail(fs, path)) !== original) {
    return conflict(path, 'it changed while Atomic Chat was reading it')
  }

  const options = mode === undefined ? {} : { mode }
  let backupPath: string | undefined
  try {
    for (let attempt = 1; backupPath === undefined; attempt++) {
      const candidate = codexBackupPath(path, attempt)
      if (await fs.createNew(candidate, original, options)) backupPath = candidate
    }
  } catch (e) {
    throw new AtomicCoreError(
      'IO_ERROR',
      `Could not back up ${path} before removing Atomic Chat's old settings from it, so it was left as it was.`,
      (e as Error).message
    )
  }

  try {
    await fs.write(target, plan.text, options)
  } catch (e) {
    throw new AtomicCoreError('IO_ERROR', `Failed to write ${target}`, (e as Error).message)
  }
  return { kind: 'repaired', backupPath, legacy: plan.legacy }
}
