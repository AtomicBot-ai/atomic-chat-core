#!/usr/bin/env node
// Live proof that `inventory_digest` in test/fixtures/runtimes/tensorrt-llm.json matches what
// this core's own algorithm (src/runtime/environment/inventory.ts) computes from each curated
// model's *real* Hugging Face file listing, for every curated entry (task 2.16).
//
// Not run by any test and not wired into `npm test` / CI: it fetches from the live Hugging Face
// API, which unit tests must never do (design D12, "core MUST NOT touch the network"). Task 2.16
// found no HF-listing fixtures for these repositories in atomic-chat-conf (only its synthetic
// vectors in .github/scripts/inventory-digest.test.mjs, reused verbatim by
// src/runtime/environment/inventory.test.ts) — this script is the deferred live-data proof the
// brief asks for when such fixtures do not exist.
//
//   node scripts/verify-curated-inventory-digests.mjs [path/to/tensorrt-llm.json]
//   node scripts/verify-curated-inventory-digests.mjs --write-fixtures test/fixtures/tensorrt-llm/hf-listings
//
// Plain mode only prints OK/FAIL per curated model. `--write-fixtures <dir>` additionally writes
// each curated model's raw Hugging Face API response body *verbatim* to `<dir>/<owner>__<name>.json`
// (GET only, no token — every `curated_models[]` repository must stay ungated, conf README), so
// `src/runtime/tensorrt-llm/curated-inventory-digests.test.ts` can replay the exact same listings
// through core's own `inventoryDigest` without ever touching the network itself. Run this again,
// by hand, only when the descriptor's curated list changes (a new engine tag, a re-resolved
// revision, ...); the written fixtures are what the test suite actually checks against afterwards.
//
// The digest algorithm below is copied from src/runtime/environment/inventory.ts (which is itself
// required to match atomic-chat-conf's .github/scripts/inventory-digest.mjs byte-for-byte, per
// that repo's README "Runtime descriptors" section) rather than imported, so this script stays a
// dependency-free, standalone `.mjs` like conf's own script — the same choice conf made for the
// same reason. If this ever needs to change, change src/runtime/environment/inventory.ts first and
// mirror the change here; inventory.test.ts pins the shared test vectors that prove the two agree.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const NUL = String.fromCharCode(0)

function inventoryDigest(files) {
  if (files.length === 0) throw new Error('A checkpoint with no files is not a checkpoint.')
  const seen = new Set()
  const hash = createHash('sha256')
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (const file of sorted) {
    if (typeof file.path !== 'string' || file.path === '' || file.path.includes(NUL)) {
      throw new Error(`An artifact's file path cannot be empty: ${JSON.stringify(file.path)}`)
    }
    if (seen.has(file.path)) throw new Error(`The inventory lists a file twice: ${file.path}`)
    seen.add(file.path)
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      throw new Error(`A file size is not a whole number: ${file.path}`)
    }
    hash.update(`${file.path.length}:${file.path}`)
    hash.update(`|${file.bytes}|`)
    hash.update(file.sha256 ?? '')
    hash.update(NUL)
  }
  return `sha256:${hash.digest('hex')}`
}

function filesFromHfSiblings(siblings) {
  return siblings.map((sibling) => {
    const lfs = sibling.lfs && typeof sibling.lfs === 'object' ? sibling.lfs : {}
    const bytes =
      (Number.isSafeInteger(lfs.size) && lfs.size >= 0 ? lfs.size : undefined) ??
      (Number.isSafeInteger(sibling.size) && sibling.size >= 0 ? sibling.size : undefined) ??
      0
    const sha256 = typeof lfs.sha256 === 'string' && lfs.sha256 ? lfs.sha256 : undefined
    return { path: sibling.rfilename, bytes, ...(sha256 ? { sha256 } : {}) }
  })
}

/** GET-only, no token: every curated repository must stay ungated (conf README). */
async function fetchListing(repository, revision) {
  const url = `https://huggingface.co/api/models/${repository}/revision/${encodeURIComponent(revision)}?blobs=true&files_metadata=true`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Hugging Face returned HTTP ${response.status} for ${url}`)
  const body = await response.json()
  if (!Array.isArray(body.siblings)) throw new Error('Unexpected Hugging Face response: no siblings')
  if (body.sha !== revision) {
    throw new Error(`Asked for revision ${revision}, Hugging Face resolved ${body.sha}`)
  }
  return body
}

/** `owner/name` -> a safe, unambiguous filename (`/` cannot appear in a path segment). */
function fixtureFileName(repository) {
  return `${repository.replace(/\//g, '__')}.json`
}

function parseArgs(args) {
  const writeIndex = args.indexOf('--write-fixtures')
  const writeFixturesDir = writeIndex > -1 ? args[writeIndex + 1] : undefined
  if (writeIndex > -1 && !writeFixturesDir) {
    throw new Error('--write-fixtures needs a directory argument')
  }
  const positional = args.filter((arg, index) => arg !== '--write-fixtures' && index !== writeIndex + 1)
  return { fixturePath: positional[0], writeFixturesDir }
}

async function main(args) {
  const { fixturePath: fixturePathArg, writeFixturesDir } = parseArgs(args)
  const fixturePath = fixturePathArg
    ? new URL(fixturePathArg, `file://${process.cwd()}/`)
    : new URL('../test/fixtures/runtimes/tensorrt-llm.json', import.meta.url)
  const descriptor = JSON.parse(readFileSync(fileURLToPath(fixturePath), 'utf8'))
  const curatedModels = descriptor.curated_models ?? []
  console.log(`Verifying ${curatedModels.length} curated model(s) against the live Hugging Face API…`)
  if (writeFixturesDir) mkdirSync(writeFixturesDir, { recursive: true })

  let failures = 0
  for (const model of curatedModels) {
    try {
      const listing = await fetchListing(model.repository, model.revision)
      if (writeFixturesDir) {
        const dest = `${writeFixturesDir}/${fixtureFileName(model.repository)}`
        writeFileSync(dest, `${JSON.stringify(listing, null, 2)}\n`)
        console.log(`     wrote ${dest}`)
      }
      const actual = inventoryDigest(filesFromHfSiblings(listing.siblings))
      const ok = actual === model.inventory_digest
      if (!ok) failures += 1
      console.log(
        `${ok ? 'OK  ' : 'FAIL'} ${model.repository}@${model.revision}\n` +
          `     expected ${model.inventory_digest}\n` +
          `     actual   ${actual}`
      )
    } catch (error) {
      failures += 1
      console.log(`FAIL ${model.repository}@${model.revision}\n     ${error.message}`)
    }
  }

  if (failures > 0) {
    console.error(`${failures}/${curatedModels.length} curated model(s) failed to verify.`)
    process.exitCode = 1
  } else {
    console.log(`All ${curatedModels.length} curated model(s) verified.`)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
