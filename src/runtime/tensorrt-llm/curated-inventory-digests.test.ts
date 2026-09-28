/**
 * The 11-curated-entry proof (task 2.16, brief): that every `curated_models[].inventory_digest` in
 * the published descriptor (`test/fixtures/runtimes/tensorrt-llm.json`) matches what core's own
 * `inventoryDigest` (`src/runtime/environment/index.js`) computes from that repository's *real*
 * Hugging Face file listing at the pinned revision — not conf's synthetic test vectors
 * (`inventory.test.ts` already covers those), the actual listings.
 *
 * `atomic-chat-conf` carries no HF-listing fixtures for these specific repositories, so this test
 * replays verbatim listings fetched once, by hand, with
 * `node scripts/verify-curated-inventory-digests.mjs --write-fixtures test/fixtures/tensorrt-llm/hf-listings`
 * (RULING: the public Hugging Face API is reachable from this worktree; that run printed `OK` for
 * all 11 entries before these fixtures were checked in). This test itself never touches the
 * network — it only reads the checked-in JSON files (design D12).
 */
import { describe, expect, it } from 'vitest'
import {
  filesFromHfSiblings,
  hfListingFixtureName,
  readHfListingFixture,
  type HfListing,
} from '../../../test/helpers/hf-listing-fixtures.js'
import { readRuntimeFixture } from '../../../test/helpers/runtime-fixtures.js'
import { inventoryDigest, parseRuntimeDescriptor } from '../environment/index.js'

describe('curated_models[].inventory_digest matches the real Hugging Face listing, for all 11 curated entries', () => {
  const descriptor = parseRuntimeDescriptor(readRuntimeFixture('tensorrt-llm.json'))

  it('the fixture actually has 11 curated entries (sanity on the premise of this test)', () => {
    expect(descriptor.curated_models).toHaveLength(11)
  })

  for (const model of descriptor.curated_models) {
    it(`${model.repository}@${model.revision}`, () => {
      const listing = readHfListingFixture(hfListingFixtureName(model.repository)) as HfListing
      // The fixture is the listing at the exact revision the descriptor pins, not just "whatever
      // main resolves to today" — scripts/verify-curated-inventory-digests.mjs already asserted
      // this when it fetched the fixture; re-asserting it here catches the fixture ever being
      // replaced with one for the wrong revision.
      expect(listing.sha).toBe(model.revision)

      const actualDigest = inventoryDigest(filesFromHfSiblings(listing.siblings))

      expect(actualDigest).toBe(model.inventory_digest)
    })
  }
})
