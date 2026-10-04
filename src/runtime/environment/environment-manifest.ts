/**
 * Reading an environment manifest (openspec change `extract-environment-manifest`, task 2.1; spec
 * `runtime-environment-manifest`): the data about the foundation every managed engine runs on,
 * published in conf apart from any engine descriptor, one file per platform. One parser per platform
 * (change `add-tensorrt-llm-windows`, task 2.1): Linux's lists which install recipes exist and on
 * which distributions each is qualified; Windows' pins the rootfs core imports as its own WSL
 * distribution and names the recipe that prepares the guest. A core picks the parser of its own
 * platform (`environmentManifestParser`), and each parser accepts nothing but its own `platform`, so
 * another platform's manifest never reaches it.
 *
 * Each shape follows its conf schema (`atomic-chat-conf/runtimes/environments/<platform>.schema.json`)
 * exactly, with the same strictness as the descriptor parser (`document-fields.ts`): every level
 * refuses an unknown field, so a command or a script added anywhere refuses the whole document. Conf
 * CI's integrity checks — `recipe_id` unique, a distribution unique by `(id, version_id, arch)` within
 * its recipe, `manifest_id` prefixed by its platform — hold here too. An empty `recipes` list is a
 * valid Linux manifest (conf ruling 1.1): it qualifies no distribution for automatic setup.
 */

import type {
  EnvironmentPlatform,
  LinuxEnvironmentManifest,
  WindowsEnvironmentManifest,
  WslRootfs,
} from '../../contracts/index.js'
import {
  DOCUMENT_ID,
  DOCUMENT_ID_LABEL,
  DOCUMENT_SEMVER,
  documentFields,
  installRecipe,
  type DocumentFields,
} from './document-fields.js'

/** `manifest_id`: `<platform>-r<N>` (schema `properties.manifest_id.pattern`). */
const LINUX_MANIFEST_ID = /^linux-r[0-9]+$/
/**
 * `windows-r<N>` for x64 (`windows.json`), `windows-arm64-r<N>` for Windows on Arm
 * (`windows-arm64.json`, its own file: every released core parses `windows.json` strictly and would
 * refuse an arm64 rootfs there). The id names the architecture its rootfs is for.
 */
export const WINDOWS_MANIFEST_ID = /^windows(-arm64)?-r[0-9]+$/

// Copied character-for-character from `windows.schema.json`'s `definitions.rootfs`.
/** `rootfs.url`: HTTPS only, no whitespace. */
const ROOTFS_URL = /^https:\/\/[^\s]+$/
/** `rootfs.sha256`: lowercase hex, 64 characters. */
const ROOTFS_SHA256 = /^[0-9a-f]{64}$/
const DISTRIBUTION_ID = /^[a-z0-9._-]+$/
const VERSION_ID = /^[0-9][0-9.]*$/

const SEMVER_LABEL = 'a semver version (major.minor.patch)'

const LINUX_KEYS = ['schema_version', 'manifest_id', 'platform', 'minimum_core_version', 'recipes'] as const
const WINDOWS_KEYS = [
  'schema_version',
  'manifest_id',
  'platform',
  'minimum_core_version',
  'minimum_windows_build',
  'minimum_wsl_version',
  'rootfs',
  'guest_recipe_id',
] as const
const ROOTFS_KEYS = ['url', 'sha256', 'distribution'] as const
const ROOTFS_DISTRIBUTION_KEYS = ['id', 'version_id', 'arch'] as const

const fields = documentFields('environment manifest')

/** The checks every platform's manifest starts with: an object, known keys, version 1, its own platform. */
function manifestObject(
  input: unknown,
  keys: readonly string[],
  platform: EnvironmentPlatform
): Record<string, unknown> {
  const raw = fields.object(input, 'the manifest')
  fields.known(raw, 'the manifest', keys)
  if (raw['schema_version'] !== 1) {
    fields.fail('schema_version is not 1', JSON.stringify(raw['schema_version']))
  }
  if (raw['platform'] !== platform) {
    fields.fail(`platform is not ${platform}`, JSON.stringify(raw['platform']))
  }
  return raw
}

/** Validate one Linux environment manifest; throws `MANAGED_METADATA_INVALID` naming the first misfit. */
export function parseLinuxEnvironmentManifest(input: unknown): LinuxEnvironmentManifest {
  const raw = manifestObject(input, LINUX_KEYS, 'linux')

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
    minimum_core_version: fields.pattern(DOCUMENT_SEMVER, SEMVER_LABEL)(
      raw['minimum_core_version'],
      'minimum_core_version'
    ),
    recipes,
  }
}

/** Validate one Windows environment manifest; throws `MANAGED_METADATA_INVALID` naming the first misfit. */
export function parseWindowsEnvironmentManifest(input: unknown): WindowsEnvironmentManifest {
  const raw = manifestObject(input, WINDOWS_KEYS, 'windows')

  const build = raw['minimum_windows_build']
  if (typeof build !== 'number' || !Number.isSafeInteger(build) || build < 1) {
    fields.fail('minimum_windows_build is not a whole number >= 1', JSON.stringify(build))
  }

  const manifestId = fields.pattern(
    WINDOWS_MANIFEST_ID,
    'a Windows manifest id (windows-r<N> or windows-arm64-r<N>)'
  )(raw['manifest_id'], 'manifest_id')

  return {
    schema_version: 1,
    manifest_id: manifestId,
    platform: 'windows',
    minimum_core_version: fields.pattern(DOCUMENT_SEMVER, SEMVER_LABEL)(
      raw['minimum_core_version'],
      'minimum_core_version'
    ),
    minimum_windows_build: build as number,
    minimum_wsl_version: fields.pattern(DOCUMENT_SEMVER, SEMVER_LABEL)(
      raw['minimum_wsl_version'],
      'minimum_wsl_version'
    ),
    rootfs: rootfsFor(manifestId, rootfs(fields, raw['rootfs'])),
    guest_recipe_id: fields.pattern(DOCUMENT_ID, DOCUMENT_ID_LABEL)(
      raw['guest_recipe_id'],
      'guest_recipe_id'
    ),
  }
}

/** An arm64 manifest carries an aarch64 guest and an x64 one an x86_64 guest — never the other. */
function rootfsFor(manifestId: string, entry: WslRootfs): WslRootfs {
  const expected = manifestId.startsWith('windows-arm64-') ? 'aarch64' : 'x86_64'
  if (entry.distribution.arch !== expected) {
    fields.fail(`rootfs.distribution.arch is not ${expected} for ${manifestId}`, entry.distribution.arch)
  }
  return entry
}

/** `#/definitions/rootfs`: where the guest comes from and what it is — never how to import it. */
function rootfs(fields: DocumentFields, value: unknown): WslRootfs {
  const entry = fields.object(value, 'rootfs')
  fields.known(entry, 'rootfs', ROOTFS_KEYS)
  const distribution = fields.object(entry['distribution'], 'rootfs.distribution')
  fields.known(distribution, 'rootfs.distribution', ROOTFS_DISTRIBUTION_KEYS)
  const arch = distribution['arch']
  if (arch !== 'x86_64' && arch !== 'aarch64') {
    fields.fail('rootfs.distribution.arch is not x86_64 or aarch64', JSON.stringify(arch))
  }
  return {
    url: fields.pattern(ROOTFS_URL, 'an https:// URL')(entry['url'], 'rootfs.url'),
    sha256: fields.pattern(ROOTFS_SHA256, '64 lowercase hex characters')(entry['sha256'], 'rootfs.sha256'),
    distribution: {
      id: fields.pattern(DISTRIBUTION_ID, 'an os-release id')(distribution['id'], 'rootfs.distribution.id'),
      version_id: fields.pattern(VERSION_ID, 'an os-release version id')(
        distribution['version_id'],
        'rootfs.distribution.version_id'
      ),
      arch: arch as 'x86_64' | 'aarch64',
    },
  }
}

/** Which manifest each platform reads. */
export interface EnvironmentManifestByPlatform {
  linux: LinuxEnvironmentManifest
  windows: WindowsEnvironmentManifest
}

/** The parser of one platform's manifest: it refuses every other platform's document. */
export function environmentManifestParser<P extends EnvironmentPlatform>(
  platform: P
): (input: unknown) => EnvironmentManifestByPlatform[P] {
  const parsers: { [K in EnvironmentPlatform]: (input: unknown) => EnvironmentManifestByPlatform[K] } = {
    linux: parseLinuxEnvironmentManifest,
    windows: parseWindowsEnvironmentManifest,
  }
  return parsers[platform] as (input: unknown) => EnvironmentManifestByPlatform[P]
}
