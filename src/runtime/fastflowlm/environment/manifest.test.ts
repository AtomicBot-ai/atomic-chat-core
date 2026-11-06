import { expect, it } from 'vitest'
import { linuxManifest, windowsManifest } from '../../../../test/helpers/flm-environment.js'
import { parseEnvironment } from './manifest.js'
it('accepts empty bootstrap documents and both qualified shapes', () => {
  for (const [doc, os] of [
    [linuxManifest(), 'linux'],
    [windowsManifest(), 'windows'],
  ] as const) {
    expect(parseEnvironment(doc, os)).toEqual(doc)
    expect(parseEnvironment({ ...doc, recipes: [] }, os).recipes).toEqual([])
  }
})
it('rejects foreign origins, cross-suite dependencies, traversal, missing hashes and extra executable fields', () => {
  for (const change of [
    (r: ReturnType<typeof linuxManifest>['recipes'][number]) => {
      r.sources[0]!.url = 'https://evil.test/'
    },
    (r) => {
      r.sources[0]!.suite = 'resolute'
    },
    (r) => {
      r.packages[0]!.path = 'pool/../evil.deb'
    },
    (r) => {
      r.packages[0]!.sha256 = ''
    },
    (r) => {
      Object.assign(r.packages[0]!, { command: 'apt upgrade' })
    },
    (r) => {
      r.qualification.evidence.url = r.qualification.evidence.url.replace('-r2/', '-r1/')
    },
  ] satisfies ((r: ReturnType<typeof linuxManifest>['recipes'][number]) => void)[]) {
    const doc = linuxManifest()
    change(doc.recipes[0]!)
    expect(() => parseEnvironment(doc, 'linux')).toThrow()
  }
  const doc = windowsManifest()
  doc.recipes[0]!.driver.url = 'https://download.amd.com/driver.cab'
  expect(() => parseEnvironment(doc, 'windows')).toThrow()
})
