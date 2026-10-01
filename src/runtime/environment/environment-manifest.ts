/**
 * Reading an environment manifest (openspec change `extract-environment-manifest`, task 2.1; spec
 * `runtime-environment-manifest`): the data about the foundation every managed engine runs on —
 * which install recipes exist and on which distributions each is qualified — published in conf
 * apart from any engine descriptor, one file per platform. This build reads only
 * `runtimes/environments/linux.json`.
 *
 * The shape follows `atomic-chat-conf/runtimes/environments/linux.schema.json` exactly, with the
 * same strictness as the descriptor parser (`document-fields.ts`): every level refuses an unknown
 * field, so a command or a script added to a recipe refuses the whole document. Conf CI's integrity
 * checks — `recipe_id` unique, a distribution unique by `(id, version_id, arch)` within its recipe —
 * hold here too. An empty `recipes` list is a valid manifest (conf ruling 1.1): it qualifies no
 * distribution for automatic setup.
 */

import type { EnvironmentManifest } from '../../contracts/index.js'
import { DOCUMENT_SEMVER, documentFields, installRecipe } from './document-fields.js'

/** `manifest_id`: `<platform>-r<N>`, here always Linux's (schema `properties.manifest_id.pattern`). */
const LINUX_MANIFEST_ID = /^linux-r[0-9]+$/

const MANIFEST_KEYS = [
  'schema_version',
  'manifest_id',
  'platform',
  'minimum_core_version',
  'recipes',
] as const

const fields = documentFields('environment manifest')

/** Validate one Linux environment manifest; throws `MANAGED_METADATA_INVALID` naming the first misfit. */
export function parseEnvironmentManifest(input: unknown): EnvironmentManifest {
  const raw = fields.object(input, 'the manifest')
  fields.known(raw, 'the manifest', MANIFEST_KEYS)

  if (raw['schema_version'] !== 1) {
    fields.fail('schema_version is not 1', JSON.stringify(raw['schema_version']))
  }
  if (raw['platform'] !== 'linux') {
    fields.fail('platform is not linux', JSON.stringify(raw['platform']))
  }

  const recipes = fields
    .list(raw['recipes'], 'recipes')
    .map((item, i) => installRecipe(fields, item, `recipes[${i}]`))
  fields.unique(
    recipes.map((recipe) => recipe.recipe_id),
    'recipes',
    'a recipe id'
  )

  return {
    schema_version: 1,
    manifest_id: fields.pattern(LINUX_MANIFEST_ID, 'a Linux manifest id (linux-r<N>)')(
      raw['manifest_id'],
      'manifest_id'
    ),
    platform: 'linux',
    minimum_core_version: fields.pattern(DOCUMENT_SEMVER, 'a semver version (major.minor.patch)')(
      raw['minimum_core_version'],
      'minimum_core_version'
    ),
    recipes,
  }
}
