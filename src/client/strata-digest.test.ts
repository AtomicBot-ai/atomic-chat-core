import { expect, it } from 'vitest'
import fixture from '../../test/fixtures/strata/catalog.json' with { type: 'json' }
import { strataSourceDigest, strataCanonicalDescriptor } from './strata-digest.js'
it('binds every recipe input independently of JSON property order', async () => {
  const descriptor = Object.values(fixture.models)[0]!.definition
  const reordered = Object.fromEntries(Object.entries(descriptor).reverse())
  const expected = 'fa5974ab36cfbd14089c935d0693080058ab97fad55afe9bfe28eae80f621623'
  expect(strataCanonicalDescriptor(reordered)).toBe(strataCanonicalDescriptor(descriptor))
  expect(await strataSourceDigest(descriptor)).toBe(expected)
  expect(await strataSourceDigest(reordered)).toBe(expected)
  expect(await strataSourceDigest({ ...descriptor, name: descriptor.name + ' changed' })).not.toBe(expected)
})
