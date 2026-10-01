/**
 * The strict field readers both conf documents core trusts are parsed with: a runtime descriptor
 * (`descriptor.ts`) and an environment manifest (`environment-manifest.ts`). Each reader either
 * returns the value in its checked type or throws `AtomicCoreError('MANAGED_METADATA_INVALID', …)`
 * naming the field — a document arrives over HTTPS and is never trusted blind, and an unknown field
 * refuses the whole document rather than being dropped (a newer shape announces itself with
 * `schema_version`, never with a field this build would silently ignore).
 *
 * `subject` only names the document in the message ("Invalid runtime descriptor: …"), so one shared
 * set of readers keeps both parsers equally strict without either copying the other.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import type { InstallRecipe, RecipeDistribution } from '../../contracts/index.js'

export interface DocumentFields {
  fail(why: string, details?: string): never
  object(value: unknown, at: string): Record<string, unknown>
  /** Refuses any key outside `keys`, naming every extra one. */
  known(source: Record<string, unknown>, at: string, keys: readonly string[]): void
  text(value: unknown, at: string): string
  boolean(value: unknown, at: string): boolean
  pattern(re: RegExp, label: string): (value: unknown, at: string) => string
  list(value: unknown, at: string): unknown[]
  strings(value: unknown, at: string): string[]
  unique(values: string[], at: string, what: string): void
  /** A whole number of bytes no lower than `min`. */
  bytes(value: unknown, at: string, min?: number): number
}

export function documentFields(subject: string): DocumentFields {
  const fail = (why: string, details?: string): never => {
    throw new AtomicCoreError('MANAGED_METADATA_INVALID', `Invalid ${subject}: ${why}`, details)
  }

  const object = (value: unknown, at: string): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : fail(`${at} is not an object`)

  const known = (source: Record<string, unknown>, at: string, keys: readonly string[]): void => {
    const extra = Object.keys(source).filter((key) => !keys.includes(key))
    if (extra.length > 0) fail(`${at} has unknown fields`, extra.sort().join(', '))
  }

  const text = (value: unknown, at: string): string =>
    typeof value === 'string' && value.trim() !== '' ? value : fail(`${at} is not a non-empty string`)

  const boolean = (value: unknown, at: string): boolean =>
    typeof value === 'boolean' ? value : fail(`${at} is not a boolean`)

  const pattern =
    (re: RegExp, label: string) =>
    (value: unknown, at: string): string =>
      typeof value === 'string' && re.test(value)
        ? value
        : fail(`${at} is not ${label}`, typeof value === 'string' ? value : undefined)

  const list = (value: unknown, at: string): unknown[] =>
    Array.isArray(value) ? value : fail(`${at} is not an array`)

  const strings = (value: unknown, at: string): string[] =>
    list(value, at).map((item, i) => text(item, `${at}[${i}]`))

  const unique = (values: string[], at: string, what: string): void => {
    const seen = new Set<string>()
    for (const value of values) {
      if (seen.has(value)) fail(`${at} lists ${what} twice`, value)
      seen.add(value)
    }
  }

  const bytes = (value: unknown, at: string, min = 0): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
      fail(
        `${at} is not a whole number of bytes >= ${min}`,
        typeof value === 'number' ? String(value) : undefined
      )
    }
    return value as number
  }

  return { fail, object, known, text, boolean, pattern, list, strings, unique, bytes }
}

// The patterns below are copied character-for-character from the conf schemas' `definitions`
// (`runtimes/schema.json`, `runtimes/environments/linux.schema.json`), so this trust boundary is at
// least as strict as what conf CI already enforced on the published document. Do not relax one
// without updating the schema first.

/** `#/definitions/id`: `descriptor_id`, `engine_id`, `adapter_id`, `recipes[].recipe_id`. */
export const DOCUMENT_ID = /^[a-z0-9][a-z0-9.-]*$/
export const DOCUMENT_ID_LABEL = 'a valid id (lowercase, starting with a letter or digit)'
/** `#/definitions/semver`: `minimum_core_version`, `minimum_app_version`. */
export const DOCUMENT_SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/
/** `distribution.id`: `os-release` `ID`, e.g. `ubuntu`, `fedora`. */
const DISTRIBUTION_ID = /^[a-z0-9._-]+$/
/** `distribution.version_id`: `os-release` `VERSION_ID`, e.g. `22.04`. */
const VERSION_ID = /^[0-9][0-9.]*$/
const ARCHES = ['x86_64', 'aarch64'] as const

const DISTRIBUTION_KEYS = ['id', 'version_id', 'arch'] as const
const RECIPE_KEYS = ['recipe_id', 'distributions'] as const

/**
 * `#/definitions/recipe`: an id naming argv compiled into core and a non-empty list of the
 * distributions it is qualified for — nothing else, so a command or a script has nowhere to go.
 * Distributions are unique by `(id, version_id, arch)` within the recipe: conf CI's integrity check,
 * enforced here as well.
 */
export function installRecipe(fields: DocumentFields, value: unknown, at: string): InstallRecipe {
  const entry = fields.object(value, at)
  fields.known(entry, at, RECIPE_KEYS)
  const distributions = fields
    .list(entry['distributions'], `${at}.distributions`)
    .map((item, i) => distribution(fields, item, `${at}.distributions[${i}]`))
  if (distributions.length === 0) fields.fail(`${at}.distributions is empty`)
  fields.unique(
    distributions.map((d) => `${d.id} ${d.version_id} ${d.arch}`),
    `${at}.distributions`,
    'a distribution'
  )
  return {
    recipe_id: fields.pattern(DOCUMENT_ID, DOCUMENT_ID_LABEL)(entry['recipe_id'], `${at}.recipe_id`),
    distributions,
  }
}

function distribution(fields: DocumentFields, value: unknown, at: string): RecipeDistribution {
  const entry = fields.object(value, at)
  fields.known(entry, at, DISTRIBUTION_KEYS)
  const arch = fields.text(entry['arch'], `${at}.arch`)
  if (!(ARCHES as readonly string[]).includes(arch)) fields.fail(`${at}.arch is not x86_64 or aarch64`, arch)
  return {
    id: fields.pattern(DISTRIBUTION_ID, 'an os-release id')(entry['id'], `${at}.id`),
    version_id: fields.pattern(VERSION_ID, 'an os-release version id')(
      entry['version_id'],
      `${at}.version_id`
    ),
    arch: arch as RecipeDistribution['arch'],
  }
}
