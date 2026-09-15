#!/usr/bin/env node
// Every source file that exports a function or class must have a sibling `<name>.test.ts`
// (AGENTS.md §5). Exemptions live in test/test-quality-allowlist.json with a reason each.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const SRC = join(ROOT, 'src')
const allowlist = JSON.parse(readFileSync(join(ROOT, 'test/test-quality-allowlist.json'), 'utf8'))
const allowed = new Map(Object.entries(allowlist.files ?? {}))

const EXPORT_RE = /^export\s+(?:async\s+)?(?:function|class)\s+[A-Za-z_$][\w$]*/m

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) yield p
  }
}

const missing = []
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file)
  if (/\/index\.ts$/.test(rel) || rel.startsWith('src/contracts/')) continue
  const text = readFileSync(file, 'utf8')
  if (!EXPORT_RE.test(text)) continue
  const testPath = file.replace(/\.ts$/, '.test.ts')
  if (existsSync(testPath)) continue
  if (allowed.has(rel)) continue
  missing.push(rel)
}

for (const [file, reason] of allowed) {
  if (!existsSync(join(ROOT, file)))
    console.warn(`allowlist: ${file} no longer exists (reason was: ${reason})`)
}

if (missing.length) {
  console.error(
    'Exported functions/classes without a sibling test:\n' + missing.map((f) => `  ${f}`).join('\n')
  )
  console.error(
    '\nAdd `<name>.test.ts` next to the file, or list it in test/test-quality-allowlist.json with a reason.'
  )
  process.exit(1)
}
console.log('test-quality: ok')
