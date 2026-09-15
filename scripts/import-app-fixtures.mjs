#!/usr/bin/env node
// Copy contract fixtures emitted by the app's Rust tests into test/fixtures/ and record a checksum
// so drift is visible on both sides. Phase 0 wires the emitters in ../Atomic-Chat:
//   cd ../Atomic-Chat/src-tauri && cargo test -- --ignored dump_fixtures
//
//   node scripts/import-app-fixtures.mjs [--app ../Atomic-Chat]
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const appArg = process.argv.indexOf('--app')
const APP = resolve(ROOT, appArg > -1 ? process.argv[appArg + 1] : '../Atomic-Chat')
const SRC = join(APP, 'tests/fixtures/core-contracts')
const DEST = join(ROOT, 'test/fixtures/app')

if (!existsSync(SRC)) {
  console.error(`No fixtures at ${SRC}. Run the emitters in the app repo first (see header).`)
  process.exit(1)
}

mkdirSync(DEST, { recursive: true })
cpSync(SRC, DEST, { recursive: true })

function* walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (name !== 'CHECKSUM') yield p
  }
}
const hash = createHash('sha256')
let count = 0
for (const f of walk(DEST)) {
  hash.update(relative(DEST, f))
  hash.update(readFileSync(f))
  count++
}
const digest = hash.digest('hex')
writeFileSync(join(DEST, 'CHECKSUM'), `${digest}\n`)
// The app's tests/core-contracts.test.mjs recomputes the same digest, so both repos hold one value.
writeFileSync(join(SRC, 'CHECKSUM'), `${digest}\n`)
console.log(`imported ${count} fixture files from ${SRC}\nsha256 ${digest}`)
