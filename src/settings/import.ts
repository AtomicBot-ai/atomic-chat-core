/**
 * Importing the desktop app's legacy settings into the core (PLAN.md §3.4,
 * "Миграция настроек — до первого core-load").
 *
 * Until a provider's settings are imported, the app's copy is the truth and the core must not own
 * that provider's runtime. Import is what moves that line — and it has to survive being run more
 * than once, because the app runs it on every start and the user may have changed settings on
 * either side in between.
 *
 * So it is a three-way merge, not a copy. The base is what the legacy side looked like the last
 * time we imported it (for a first import, the provider's own defaults — anything the core differs
 * from there is a deliberate change someone made through the CLI). A key only the app changed is
 * taken; a key only the core changed is kept; a key both changed to different values is a conflict,
 * and conflicts are reported rather than resolved. Resolving one by file timestamp is explicitly
 * forbidden: the app writes its settings file on every start, so its mtime says nothing about when
 * a human last changed a value.
 */

import { createHash } from 'node:crypto'

export type ImportStatus = 'imported' | 'unchanged' | 'merged' | 'conflict'

/** One key both sides moved away from the base, in different directions. */
export interface FieldConflict {
  key: string
  base: unknown
  core: unknown
  legacy: unknown
}

export interface MergePlan {
  /** Values to write into the core. Empty when there is nothing to do, or on a conflict. */
  apply: Record<string, unknown>
  conflicts: FieldConflict[]
}

/** How the caller settles a conflict: take one side, or supply a third value. */
export type Resolution = 'core' | 'legacy' | { value: unknown }

export type Resolutions = Record<string, Resolution>

/**
 * A stable fingerprint of the legacy values, used only to answer "is this the same import I already
 * did?". Keys are sorted recursively so a re-serialised object hashes the same.
 */
export function legacyHash(values: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(values)).digest('hex')
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
  return `{${entries.join(',')}}`
}

export function jsonEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b)
}

/**
 * Decide what to write, given the three sides.
 *
 * `base` is the legacy state as it was at the last import; pass the provider's defaults for a first
 * import, so that a value the CLI already changed is seen as a change rather than as the starting
 * point.
 */
export function planImport(
  base: Record<string, unknown>,
  core: Record<string, unknown>,
  legacy: Record<string, unknown>,
  resolutions: Resolutions = {}
): MergePlan {
  const apply: Record<string, unknown> = {}
  const conflicts: FieldConflict[] = []
  const keys = new Set([...Object.keys(base), ...Object.keys(core), ...Object.keys(legacy)])

  for (const key of [...keys].sort()) {
    const b = base[key]
    const c = core[key]
    const l = legacy[key]

    // A key the app does not carry is a key the app has no opinion about — an older version that
    // never had the setting, or one it dropped. Absence is not "unset this": writing `undefined`
    // here would clobber a value the core legitimately holds with nothing at all.
    if (!(key in legacy)) continue
    // The app did not touch this key since the last import, so whatever the core holds — its own
    // default, or a change made through the CLI — stands.
    if (jsonEqual(l, b)) continue
    // Both sides agree already; nothing to write.
    if (jsonEqual(c, l)) continue
    // Only the app moved: take its value.
    if (jsonEqual(c, b)) {
      apply[key] = l
      continue
    }

    const resolution = resolutions[key]
    if (resolution === undefined) {
      conflicts.push({ key, base: b, core: c, legacy: l })
      continue
    }
    if (resolution === 'legacy') apply[key] = l
    else if (resolution !== 'core') apply[key] = resolution.value
    // 'core' means keep what the core has, which is writing nothing.
  }

  // A conflict anywhere means this scope is not migrated, so nothing is written at all. A partial
  // write would leave the app and the core disagreeing about a scope neither side has accepted.
  if (conflicts.length > 0) return { apply: {}, conflicts }
  return { apply, conflicts }
}

export interface ImportOutcome {
  status: ImportStatus
  /** Keys actually written. */
  applied: string[]
  conflicts: FieldConflict[]
}

/**
 * Classify a planned import. Separated from the store so the decision is testable on its own and so
 * the store only has to persist the result.
 */
export function classifyImport(
  previousHash: string | null,
  hasBaseline: boolean,
  incomingHash: string,
  plan: MergePlan
): ImportStatus {
  if (plan.conflicts.length > 0) return 'conflict'
  // The same legacy state we already imported. Repeating it is not an error and not a no-op the
  // caller has to distinguish — it simply reports what happened last time.
  if (previousHash !== null && previousHash === incomingHash) return 'unchanged'
  if (!hasBaseline) return 'imported'
  return 'merged'
}
