#!/usr/bin/env node
// Module boundary gate (AGENTS.md §3.1): "One module = one folder with index.ts as the only public
// entry. Cross-module imports go through index.ts." Fails when a file imports a file of another
// module without going through that module's index.
//
// A module is the importing file's top-level src/<module>/ directory; inside src/runtime/ it is the
// engine (src/runtime/llamacpp, src/runtime/mlx, src/runtime/managed-text, ...), which is what the
// repo map lists as the module row and what "the core runs itself" treats as one engine. Three
// exemptions are deliberate:
// - a file directly under src/ (src/app-daemon.ts, the app entry) belongs to src itself, so every
//   import inside src stays inside its module;
// - an index.ts is never checked: it defines its module's surface, and re-exporting a named file of
//   a neighbour there (tensorrt-llm/index.ts re-exports managed-models' quant-format) is the
//   deliberate surface choice;
// - the target is a file directly under src/ (version.ts): a module of one file, with no index
//   above it to go through.
//
// eslint's gitignore-style `../*/!(index)` could not express "not index" (the ignore package has no
// extglob), which is why the lint rule never fired; this script replaces that dead rule's intent.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const SRC = join(ROOT, 'src')

function* walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (name.endsWith('.ts')) yield p
  }
}

// The module a repo-relative path belongs to: src itself for the files directly under src/,
// src/<module> elsewhere, and inside src/runtime/ the engine src/runtime/<engine>.
function moduleOf(rel) {
  const parts = rel.split(sep)
  if (parts.length <= 2) return 'src'
  return parts[1] === 'runtime' ? `src/runtime/${parts[2]}` : `src/${parts[1]}`
}

// Static `import … from '…'` (including `import type`), side-effect `import '…'` and
// `export … from '…'` specifiers. A line that is visibly a comment is skipped, as in
// check-runtime-agnostic.mjs.
const SPEC_RE = /(?:^|\s)(?:from|import)\s*['"](\.\.?\/[^'"]+)['"]/g

const failures = []
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file)
  const parts = rel.split(sep)
  if (basename(file) === 'index.ts' || parts.length <= 2) continue
  const fileModule = moduleOf(rel)
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
    for (const match of line.matchAll(SPEC_RE)) {
      const spec = match[1]
      if (!/\.(js|ts)$/.test(spec)) continue
      const targetRel = relative(ROOT, resolve(dirname(file), spec))
      if (!targetRel.startsWith(`src${sep}`) && targetRel !== 'src') continue
      if (dirname(targetRel) === 'src') continue // top-level leaf file: no module index above it
      const base = basename(targetRel)
      if (base === 'index.js' || base === 'index.ts') continue
      if (moduleOf(targetRel) !== fileModule) {
        failures.push(`${rel}:${i + 1}: deep import '${spec}' — import the module through its index.ts`)
      }
    }
  })
}

if (failures.length) {
  console.error('Module boundary gate failed:\n' + failures.map((f) => `  ${f}`).join('\n'))
  process.exit(1)
}
console.log('module boundaries: ok')
