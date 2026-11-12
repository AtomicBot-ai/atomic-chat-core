// The digest of the app-fixture tree under test/fixtures/app, computed exactly as
// scripts/import-app-fixtures.mjs records it: files in `readdirSync(dir).sort()` order, recursive,
// the CHECKSUM file itself skipped, each file contributing its repo-relative path bytes then its
// content bytes to one sha256. test/contract/fixture-checksum.test.ts holds the checked-in
// test/fixtures/app/CHECKSUM to this value so hand-edited fixture drift is caught without the app
// repo present.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

function* walkFiles(dir) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walkFiles(p)
    else if (name !== 'CHECKSUM') yield p
  }
}

/** The sha256 the importer records for a fixture tree rooted at `rootDir`. */
export function computeFixtureChecksum(rootDir) {
  const hash = createHash('sha256')
  for (const f of walkFiles(rootDir)) {
    hash.update(relative(rootDir, f))
    hash.update(readFileSync(f))
  }
  return hash.digest('hex')
}
