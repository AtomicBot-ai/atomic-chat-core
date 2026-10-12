/**
 * The order of one managed engine's runtime descriptors (change `unify-engine-lifecycle`, design D7,
 * spec `engine-lifecycle`, "Порядок дескрипторов managed-движка"). A descriptor cannot carry a date:
 * a released core refuses a descriptor with a field it does not know. So the order is read from
 * `descriptor_id`, whose form `<engine_id>-<version>-r<n>` conf's schema enforces:
 *
 *   1. the numeric parts of the version, left to right (a missing trailing part is 0);
 *   2. a pre-release (`a<k>`, `b<k>`, `rc<k>`) is older than the same version without one, and
 *      `a` < `b` < `rc`, then by `k`;
 *   3. at an equal version, by `n`.
 *
 * An id that does not parse, or names another engine, is newer than nothing: a rollback or a typo in
 * conf must never offer a 60 GB "update".
 */

export interface DescriptorVersion {
  parts: number[]
  pre: { kind: 'a' | 'b' | 'rc'; number: number } | null
  revision: number
}

const TAIL = /^(\d+(?:\.\d+)*)(?:(a|b|rc)(\d+))?-r(\d+)$/
const PRE_RANK = { a: 0, b: 1, rc: 2 } as const

/** `<engine_id>-<version>-r<n>` of exactly this engine, or `null`. */
export function parseDescriptorId(engineId: string, descriptorId: string): DescriptorVersion | null {
  const prefix = `${engineId}-`
  if (!descriptorId.startsWith(prefix)) return null
  const match = TAIL.exec(descriptorId.slice(prefix.length))
  if (match === null) return null
  const [, version, preKind, preNumber, revision] = match
  return {
    parts: (version as string).split('.').map(Number),
    pre: preKind === undefined ? null : { kind: preKind as 'a' | 'b' | 'rc', number: Number(preNumber) },
    revision: Number(revision),
  }
}

/** Negative when `a` is older, positive when newer; two unparsable ids are equal. */
export function compareDescriptorIds(engineId: string, a: string, b: string): number {
  const left = parseDescriptorId(engineId, a)
  const right = parseDescriptorId(engineId, b)
  if (left === null || right === null) return (left === null ? 0 : 1) - (right === null ? 0 : 1)
  const length = Math.max(left.parts.length, right.parts.length)
  for (let i = 0; i < length; i++) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0)
    if (diff !== 0) return diff
  }
  if (left.pre === null || right.pre === null) {
    const diff = (left.pre === null ? 1 : 0) - (right.pre === null ? 1 : 0)
    if (diff !== 0) return diff
  } else {
    const diff = PRE_RANK[left.pre.kind] - PRE_RANK[right.pre.kind] || left.pre.number - right.pre.number
    if (diff !== 0) return diff
  }
  return left.revision - right.revision
}

/** `candidate` strictly newer than `current`; never for an unparsable or foreign candidate. */
export function isNewerDescriptor(engineId: string, candidate: string, current: string): boolean {
  return (
    parseDescriptorId(engineId, candidate) !== null && compareDescriptorIds(engineId, candidate, current) > 0
  )
}
