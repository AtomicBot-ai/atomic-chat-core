/**
 * Verbatim Hugging Face API listings for the 11 `curated_models[]` entries in
 * `test/fixtures/runtimes/tensorrt-llm.json` (`test/fixtures/tensorrt-llm/hf-listings/`), fetched
 * once by `scripts/verify-curated-inventory-digests.mjs --write-fixtures` and checked in so
 * `curated-inventory-digests.test.ts` can replay them through core's own `inventoryDigest` without
 * ever touching the network itself (design D12).
 *
 * `filesFromHfSiblings` is deliberately *not* part of `src/runtime/environment/inventory.ts`: that
 * module's own scope is only the digest over an already-`InventoryFile[]` listing (see
 * `docs/decisions/2026-09-28-inventory-ts-is-the-model-file-digest-not-the-host-report.md`), never
 * the shape of a Hugging Face API response — core does not fetch listings itself (D12), so nothing
 * in `src/` needs to know what a `sibling`/`lfs` object looks like. It lives here, test-only,
 * mirroring the same mapping `atomic-chat-conf/.github/scripts/inventory-digest.mjs` and this
 * repo's own `scripts/verify-curated-inventory-digests.mjs` use to write these fixtures in the
 * first place.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { InventoryFile } from '../../src/runtime/environment/index.js'

export function readHfListingFixture(name: string): unknown {
  const text = readFileSync(
    fileURLToPath(new URL(`../fixtures/tensorrt-llm/hf-listings/${name}`, import.meta.url)),
    'utf8'
  )
  return JSON.parse(text) as unknown
}

/** `owner/name` -> the fixture's file name, matching `scripts/verify-curated-inventory-digests.mjs`. */
export function hfListingFixtureName(repository: string): string {
  return `${repository.replace(/\//g, '__')}.json`
}

export interface HfSibling {
  rfilename: string
  size?: number
  lfs?: { size?: number; sha256?: string }
}

/** The subset of a Hugging Face API listing response this repo's fixtures/tests read. */
export interface HfListing {
  sha: string
  siblings: HfSibling[]
}

/** Every file in the response counts, not only weights (conf README, "Runtime descriptors"). */
export function filesFromHfSiblings(siblings: readonly HfSibling[]): InventoryFile[] {
  return siblings.map((sibling) => {
    const lfs = sibling.lfs
    const bytes = safeSize(lfs?.size) ?? safeSize(sibling.size) ?? 0
    const sha256 = typeof lfs?.sha256 === 'string' && lfs.sha256 ? lfs.sha256 : undefined
    return { path: sibling.rfilename, bytes, ...(sha256 ? { sha256 } : {}) }
  })
}

function safeSize(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}
