import { describe, expect, it } from 'vitest'
import fixture from '../../test/fixtures/strata/manifest.json' with { type: 'json' }
import { parseStrataManifest, strataBuildKey, checkStrataImmutability } from './strata-manifest.js'

describe('Strata manifest', () => {
  it('accepts an empty production manifest and a complete immutable fixture bundle', () => {
    expect(parseStrataManifest({ schema_version: 1, releases: [] }, '0.23.6').releases).toEqual([])
    expect(parseStrataManifest(fixture, '0.23.6')).toEqual(fixture)
    expect(strataBuildKey('strata-0.1.59-r2')).toEqual([0, 1, 59, 0, 2])
    expect(strataBuildKey('../strata-0.1.59-r2')).toBeNull()
  })
  it.each([
    ['future adapter', 'adapter_contract_version', 2],
    ['future core', 'minimum_core_version', '999.0.0'],
    ['unknown ABI', 'preparation_abi', 'strata-v99'],
  ])('skips %s before interpreting its payload', (_, key, value) => {
    const [current] = fixture.releases
    const newer = { ...current, release_id: 'strata-0.1.59-r3', [key]: value, future_field: true }
    const older = { ...current, release_id: 'strata-0.1.59-r1' }
    expect(parseStrataManifest({ ...fixture, releases: [older, newer, current] }, '0.23.6').releases).toEqual(
      [current, older]
    )
    expect(parseStrataManifest({ ...fixture, releases: [newer] }, '0.23.6').releases).toEqual([])
  })
  it.each([
    ['inconsistent version', 'engine_version', '0.1.60'],
    ['malformed minimum core', 'minimum_core_version', 'later'],
    ['malformed adapter version', 'adapter_contract_version', '2'],
    ['missing ABI', 'preparation_abi', ''],
    ['unexpected v1 field', 'future_field', true],
  ])('rejects %s', (_, key, value) => {
    const m = structuredClone(fixture)
    Object.assign(m.releases[0]!, { [key]: value })
    expect(() => parseStrataManifest(m, '0.23.6')).toThrow(/Strata/)
  })
  it.each([
    [
      'missing hash',
      (m: typeof fixture) => {
        m.releases[0]!.variants[0]!.bundle.sha256 = ''
      },
    ],
    [
      'unsafe executable',
      (m: typeof fixture) => {
        m.releases[0]!.components[0]!.executable_paths[0] = '../python'
      },
    ],
    [
      'wrong Python',
      (m: typeof fixture) => {
        m.releases[0]!.variants[0]!.bundle.python = '/usr/bin/python3'
      },
    ],
    [
      'wrong component',
      (m: typeof fixture) => {
        m.releases[0]!.components[1]!.platform = 'windows-x64'
      },
    ],
    [
      'missing validator',
      (m: typeof fixture) => {
        m.releases[0]!.components[0]!.python_modules = ['json']
      },
    ],
    [
      'wrong GPU',
      (m: typeof fixture) => {
        m.releases[0]!.variants[0]!.host.gpu_vendor = 'nvidia'
      },
    ],
    [
      'Qwen3.6 Metal',
      (m: typeof fixture) => {
        m.releases[0]!.variants[0]!.families.push('qwen36')
      },
    ],
    [
      'duplicate release',
      (m: typeof fixture) => {
        m.releases.push(m.releases[0]!)
      },
    ],
  ])('rejects %s', (_, mutate) => {
    const m = structuredClone(fixture)
    mutate(m)
    expect(() => parseStrataManifest(m, '0.23.6')).toThrow(/Strata/)
  })
  it('requires a new release id for changed payload or compatibility metadata', () => {
    const old = parseStrataManifest(fixture, '0.23.6')
    const next = structuredClone(old)
    next.releases[0]!.variants[0]!.bundle.sha256 = 'c'.repeat(64)
    expect(() => checkStrataImmutability(old, next)).toThrow(/Immutable/)
    next.releases[0]!.release_id = 'strata-0.1.59-r3'
    expect(() => checkStrataImmutability(old, next)).not.toThrow()
  })
})
