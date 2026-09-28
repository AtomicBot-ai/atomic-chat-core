/**
 * One byte sequence per value, so two sides can agree on a hash — and the hashes the managed
 * runtime makes decisions with: the fingerprint that decides whether a retried `begin` is the same
 * request, and the plan digest the user's consent is bound to.
 *
 * This is deliberately not `settings`' `stableStringify`. That one fingerprints a settings object
 * to answer "have I already imported this?", and it tolerates whatever `JSON.stringify` tolerates:
 * `undefined` disappears, `NaN` becomes `null`, a `Date` becomes a string. Those are silent
 * coercions, and a value that can be spelled two ways is a value two parties can disagree about
 * while agreeing on the hash. Here a hash stands behind a privileged install the user approved, so
 * anything that cannot be represented exactly is refused instead of coerced. Changing that older
 * function was not an option either: its hashes are already on users' disks.
 */

import { createHash } from 'node:crypto'
import { AtomicCoreError } from '../../contracts/index.js'
import type {
  BeginOperation,
  ManagedOperationTarget,
  ManagedSystemChange,
  Sha256Digest,
} from '../../contracts/index.js'

const invalid = (why: string): never => {
  throw new AtomicCoreError('MANAGED_METADATA_INVALID', `Cannot canonicalise this value: ${why}`)
}

const isPlain = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value) as object | null
  return proto === Object.prototype || proto === null
}

const write = (value: unknown, path: string): string => {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'string':
      return JSON.stringify(value)
    case 'number':
      // `NaN` and the infinities have no JSON spelling; `JSON.stringify` writes `null` for them,
      // which would make two different plans hash the same.
      return Number.isFinite(value) ? JSON.stringify(value) : invalid(`${path} is ${String(value)}`)
    case 'undefined':
      return invalid(`${path} is undefined`)
    case 'bigint':
      return invalid(`${path} is a bigint`)
    case 'function':
    case 'symbol':
      return invalid(`${path} is a ${typeof value}`)
  }
  const object = value as object
  if (Array.isArray(object)) {
    // Order is meaning here: a list of system changes in another order is another plan.
    return `[${object.map((item, index) => write(item, `${path}[${index}]`)).join(',')}]`
  }
  // A `Date`, `Map` or class instance would walk as `{}` or as its private fields. Neither is what
  // the caller meant, and both are silent.
  if (!isPlain(object)) return invalid(`${path} is not a plain object`)
  const entries = Object.entries(object as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, v]) => `${JSON.stringify(key)}:${write(v, `${path}.${key}`)}`)
  return `{${entries.join(',')}}`
}

/**
 * The canonical UTF-8 JSON of a value: object keys sorted recursively, array order kept, absent
 * properties and explicit `undefined` treated alike, and anything JSON cannot hold refused.
 */
export function canonicalJson(value: unknown): string {
  return write(value, '$')
}

/** `sha256:` + the hex digest of the canonical JSON. */
export function canonicalDigest(value: unknown): Sha256Digest {
  const hex = createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
  return `sha256:${hex}`
}

/**
 * What makes two `begin` requests the same request. The request id is the caller's idempotency key,
 * not part of the meaning, and the approved plan is consent that a resume may legitimately change,
 * so neither is hashed. Everything that decides what would be installed is.
 */
export function beginFingerprint(input: BeginOperation): Sha256Digest {
  return canonicalDigest({
    target: input.target,
    kind: input.kind,
    descriptor_id: input.descriptor_id ?? null,
    retain_models: input.retain_models ?? false,
  })
}

/**
 * What the host looked like when the plan was computed, as far as consent is concerned (spec
 * "Хост изменился до согласия": free space, the set of cards, or what is installed changed between
 * the probe and the consent). `gpu_ids` is the sorted set of GPU UUIDs. `free_disk_gib` is the free
 * space in `DockerRootDir` rounded down to whole GiB: free space moves by kilobytes on its own every
 * second (logs, caches), and a digest over the exact byte count would refuse every consent a user
 * gave a few seconds after the probe — training them to click through the one prompt that matters.
 * A whole-GiB change is a change the user could care about; "what is installed" is already in
 * `system_changes`.
 */
export interface PlanHostFingerprint {
  gpu_ids: string[]
  free_disk_gib: number | null
  docker_root_dir: string | null
}

/** Free bytes as the plan digest sees them: whole GiB, rounded down; null when unknown. */
export function freeDiskGib(bytes: number | null): number | null {
  return bytes === null ? null : Math.floor(bytes / 1024 ** 3)
}

/**
 * The part of a requirement plan the user is consenting to. Whatever changes here invalidates an
 * approval and sends the operation back to `awaiting-consent`: the target, the recipe, every system
 * change (code, parameters and the text the user read), and the host facts in `host` — the GPU set
 * and the free space where the image would land (task 2.6, carry item 1). The registry's reported
 * download size is left out: it is the descriptor's own estimate, pinned by `descriptor_id`.
 */
export interface PlanFingerprint {
  target: ManagedOperationTarget
  recipe_id: string
  recipe_digest: Sha256Digest
  /** A plan that adopts the host's existing engine changes nothing, and says so in the hash. */
  adopts_existing_engine: boolean
  system_changes: ManagedSystemChange[]
  requires_elevation: boolean
  may_require_relogin: boolean
  may_require_reboot: boolean
  /**
   * The runtime this plan would install, identified by the platform image it pins. Descriptors no
   * longer carry a separate entrypoint digest (design D1/D12 reshape to
   * `atomic-chat-conf/runtimes/schema.json`: `image` is a per-platform map, and there is nothing
   * else in a descriptor that names what actually runs) — the image digest for the host's own
   * platform is the whole identity.
   */
  descriptor: {
    descriptor_id: string
    image_digest: Sha256Digest
  } | null
  host: PlanHostFingerprint | null
}

export function planDigest(plan: PlanFingerprint): Sha256Digest {
  return canonicalDigest(plan)
}
