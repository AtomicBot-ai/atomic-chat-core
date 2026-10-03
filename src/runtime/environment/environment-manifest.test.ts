import { describe, expect, it } from 'vitest'
import { readRuntimeFixture } from '../../../test/helpers/runtime-fixtures.js'
import { AtomicCoreError } from '../../contracts/index.js'
import {
  environmentManifestParser,
  parseLinuxEnvironmentManifest,
  parseWindowsEnvironmentManifest,
} from './environment-manifest.js'

/** Deep-clones the real fixture and applies a mutation, for one-field-at-a-time rejection tests. */
const broken = (mutate: (doc: Record<string, unknown>) => void): unknown => {
  const doc = JSON.parse(JSON.stringify(readRuntimeFixture('environments/linux.json'))) as Record<
    string,
    unknown
  >
  mutate(doc)
  return doc
}

const firstRecipe = (doc: Record<string, unknown>): Record<string, unknown> =>
  (doc['recipes'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>

const distributions = (doc: Record<string, unknown>): Array<Record<string, unknown>> =>
  firstRecipe(doc)['distributions'] as Array<Record<string, unknown>>

describe('parseLinuxEnvironmentManifest', () => {
  it('accepts the published Linux manifest verbatim (conf commit 2676324)', () => {
    const manifest = parseLinuxEnvironmentManifest(readRuntimeFixture('environments/linux.json'))

    expect(manifest.manifest_id).toBe('linux-r1')
    expect(manifest.platform).toBe('linux')
    expect(manifest.minimum_core_version).toBe('0.7.5')
    expect(manifest.recipes).toHaveLength(1)
    expect(manifest.recipes[0]?.recipe_id).toBe('linux.install-container-runtime')
    expect(manifest.recipes[0]?.distributions).toContainEqual({
      id: 'ubuntu',
      version_id: '24.04',
      arch: 'x86_64',
    })
    expect(manifest.recipes[0]?.distributions).toContainEqual({
      id: 'fedora',
      version_id: '44',
      arch: 'aarch64',
    })
  })

  it('accepts an empty recipe list: a valid manifest that qualifies nothing (conf ruling 1.1)', () => {
    const manifest = parseLinuxEnvironmentManifest(broken((doc) => (doc['recipes'] = [])))
    expect(manifest.recipes).toEqual([])
  })

  it.each([
    [
      'a command on a recipe',
      (doc: Record<string, unknown>) => (firstRecipe(doc)['command'] = 'apt-get install -y docker-ce'),
    ],
    ['an unknown top-level field', (doc: Record<string, unknown>) => (doc['windows'] = { recipes: [] })],
    ['a $schema key', (doc: Record<string, unknown>) => (doc['$schema'] = './linux.schema.json')],
    [
      'an empty distribution list',
      (doc: Record<string, unknown>) => (firstRecipe(doc)['distributions'] = []),
    ],
    [
      'a distribution listed twice in one recipe',
      (doc: Record<string, unknown>) => distributions(doc).push({ ...distributions(doc)[0] }),
    ],
    [
      'a recipe id listed twice',
      (doc: Record<string, unknown>) =>
        (doc['recipes'] as unknown[]).push(JSON.parse(JSON.stringify(firstRecipe(doc))) as unknown),
    ],
    [
      'a manifest id of another platform',
      (doc: Record<string, unknown>) => (doc['manifest_id'] = 'windows-r1'),
    ],
    ['a manifest id without a revision', (doc: Record<string, unknown>) => (doc['manifest_id'] = 'linux')],
    ['another platform', (doc: Record<string, unknown>) => (doc['platform'] = 'windows')],
    ['schema_version 2', (doc: Record<string, unknown>) => (doc['schema_version'] = 2)],
    [
      'a minimum_core_version that is not semver',
      (doc: Record<string, unknown>) => (doc['minimum_core_version'] = '0.7'),
    ],
    ['no recipes field', (doc: Record<string, unknown>) => delete doc['recipes']],
    [
      'a distribution id with an uppercase letter',
      (doc: Record<string, unknown>) => (distributions(doc)[0] = { ...distributions(doc)[0], id: 'Ubuntu' }),
    ],
    [
      'a version_id that is not digits and dots',
      (doc: Record<string, unknown>) =>
        (distributions(doc)[0] = { ...distributions(doc)[0], version_id: '24.04-lts' }),
    ],
    [
      'an architecture core never runs on',
      (doc: Record<string, unknown>) =>
        (distributions(doc)[0] = { ...distributions(doc)[0], arch: 'riscv64' }),
    ],
    [
      'an extra field on a distribution',
      (doc: Record<string, unknown>) =>
        (distributions(doc)[0] = { ...distributions(doc)[0], script: 'install.sh' }),
    ],
    [
      'a recipe id with an uppercase letter',
      (doc: Record<string, unknown>) => (firstRecipe(doc)['recipe_id'] = 'Linux.x'),
    ],
  ])('rejects the manifest with %s', (_label, mutate) => {
    let caught: unknown
    try {
      parseLinuxEnvironmentManifest(broken(mutate))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AtomicCoreError)
    expect(caught).toMatchObject({ code: 'MANAGED_METADATA_INVALID' })
    expect((caught as Error).message).toMatch(/^Invalid environment manifest: /)
  })

  it('rejects something that is not an object at all', () => {
    expect(() => parseLinuxEnvironmentManifest('linux-r1')).toThrow(AtomicCoreError)
    expect(() => parseLinuxEnvironmentManifest(null)).toThrow(AtomicCoreError)
  })
})

/** Deep-clones the Windows fixture (a verbatim copy of conf's `windows-r1`) and applies a mutation. */
const brokenWindows = (mutate: (doc: Record<string, unknown>) => void): unknown => {
  const doc = JSON.parse(JSON.stringify(readRuntimeFixture('environments/windows.json'))) as Record<
    string,
    unknown
  >
  mutate(doc)
  return doc
}

const rootfs = (doc: Record<string, unknown>): Record<string, unknown> =>
  doc['rootfs'] as Record<string, unknown>

const rootfsDistribution = (doc: Record<string, unknown>): Record<string, unknown> =>
  rootfs(doc)['distribution'] as Record<string, unknown>

const refusal = (parse: () => unknown): unknown => {
  try {
    parse()
  } catch (error) {
    return error
  }
  return undefined
}

describe('parseWindowsEnvironmentManifest', () => {
  it('accepts the published Windows manifest verbatim (conf windows-r1)', () => {
    const manifest = parseWindowsEnvironmentManifest(readRuntimeFixture('environments/windows.json'))

    expect(manifest).toEqual({
      schema_version: 1,
      manifest_id: 'windows-r1',
      platform: 'windows',
      minimum_core_version: '0.7.5',
      minimum_windows_build: 22000,
      minimum_wsl_version: '2.4.4',
      rootfs: {
        url: 'https://releases.ubuntu.com/24.04.5/ubuntu-24.04.5-wsl-amd64.wsl',
        sha256: 'bb415d824822c4b878125729af451a5d18fb13d1cf5cbed9a7393ad64ac6039e',
        distribution: { id: 'ubuntu', version_id: '24.04', arch: 'x86_64' },
      },
      guest_recipe_id: 'linux.install-container-runtime',
    })
  })

  it('accepts a Windows on Arm manifest: its own id prefix and an aarch64 guest (windows-arm64.json)', () => {
    const manifest = parseWindowsEnvironmentManifest(
      brokenWindows((doc) => {
        doc['manifest_id'] = 'windows-arm64-r1'
        rootfs(doc)['url'] = 'https://example.org/ubuntu-24.04.5-wsl-arm64.wsl'
        rootfsDistribution(doc)['arch'] = 'aarch64'
      })
    )
    expect(manifest.manifest_id).toBe('windows-arm64-r1')
    expect(manifest.rootfs.distribution.arch).toBe('aarch64')
  })

  it.each([
    [
      'an aarch64 guest under an x64 manifest id',
      (doc: Record<string, unknown>) => (rootfsDistribution(doc)['arch'] = 'aarch64'),
    ],
    [
      'an x86_64 guest under an arm64 manifest id',
      (doc: Record<string, unknown>) => (doc['manifest_id'] = 'windows-arm64-r1'),
    ],
  ])('refuses %s: the id says which machines read the file', (_label, mutate) => {
    expect(() => parseWindowsEnvironmentManifest(brokenWindows(mutate))).toThrow(AtomicCoreError)
  })

  it.each([
    ['a rootfs without sha256', (doc: Record<string, unknown>) => delete rootfs(doc)['sha256']],
    [
      'a sha256 that is not 64 lowercase hex characters',
      (doc: Record<string, unknown>) => (rootfs(doc)['sha256'] = 'BB415D82'),
    ],
    [
      'an http:// rootfs URL',
      (doc: Record<string, unknown>) =>
        (rootfs(doc)['url'] = 'http://releases.ubuntu.com/24.04.5/ubuntu-24.04.5-wsl-amd64.wsl'),
    ],
    [
      'a rootfs URL with whitespace',
      (doc: Record<string, unknown>) => (rootfs(doc)['url'] = 'https://releases.ubuntu.com/a b.wsl'),
    ],
    ['an unknown top-level field', (doc: Record<string, unknown>) => (doc['recipes'] = [])],
    [
      'a command next to the rootfs',
      (doc: Record<string, unknown>) => (rootfs(doc)['command'] = 'wsl --import AtomicChat C:\\x a.wsl'),
    ],
    ['a $schema key', (doc: Record<string, unknown>) => (doc['$schema'] = './windows.schema.json')],
    [
      'a manifest id of another platform',
      (doc: Record<string, unknown>) => (doc['manifest_id'] = 'linux-r1'),
    ],
    ['another platform', (doc: Record<string, unknown>) => (doc['platform'] = 'linux')],
    ['schema_version 2', (doc: Record<string, unknown>) => (doc['schema_version'] = 2)],
    [
      'a guest architecture other than x86_64',
      (doc: Record<string, unknown>) => (rootfsDistribution(doc)['arch'] = 'aarch64'),
    ],
    [
      'a guest architecture that is neither x86_64 nor aarch64',
      (doc: Record<string, unknown>) => (rootfsDistribution(doc)['arch'] = 'riscv64'),
    ],
    [
      'a minimum_windows_build that is not a positive whole number',
      (doc: Record<string, unknown>) => (doc['minimum_windows_build'] = 22000.5),
    ],
    ['a minimum_windows_build of zero', (doc: Record<string, unknown>) => (doc['minimum_windows_build'] = 0)],
    [
      'a four-part minimum_wsl_version (conf ruling 1.1: MAJOR.MINOR.PATCH only)',
      (doc: Record<string, unknown>) => (doc['minimum_wsl_version'] = '2.4.4.0'),
    ],
    [
      'a guest recipe id with an uppercase letter',
      (doc: Record<string, unknown>) => (doc['guest_recipe_id'] = 'Linux.install'),
    ],
    ['no rootfs', (doc: Record<string, unknown>) => delete doc['rootfs']],
    [
      'an extra field on the rootfs distribution',
      (doc: Record<string, unknown>) => (rootfsDistribution(doc)['script'] = 'setup.sh'),
    ],
  ])('rejects the manifest with %s', (_label, mutate) => {
    const caught = refusal(() => parseWindowsEnvironmentManifest(brokenWindows(mutate)))
    expect(caught).toBeInstanceOf(AtomicCoreError)
    expect(caught).toMatchObject({ code: 'MANAGED_METADATA_INVALID' })
    expect((caught as Error).message).toMatch(/^Invalid environment manifest: /)
  })
})

describe('environmentManifestParser', () => {
  it('reads only its own platform: a Linux core refuses windows.json and a Windows core refuses linux.json', () => {
    const linux = readRuntimeFixture('environments/linux.json')
    const windows = readRuntimeFixture('environments/windows.json')

    expect(environmentManifestParser('linux')(linux).platform).toBe('linux')
    expect(environmentManifestParser('windows')(windows).platform).toBe('windows')
    expect(refusal(() => environmentManifestParser('linux')(windows))).toMatchObject({
      code: 'MANAGED_METADATA_INVALID',
    })
    expect(refusal(() => environmentManifestParser('windows')(linux))).toMatchObject({
      code: 'MANAGED_METADATA_INVALID',
    })
  })
})
