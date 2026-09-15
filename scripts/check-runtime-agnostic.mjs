#!/usr/bin/env node
// Runtime-agnostic gate (AGENTS.md §3.6). Fails when src/ uses Bun-only APIs, bare Node builtins,
// native addons, or when the browser-safe folders import node:*.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const SRC = join(ROOT, 'src')
const BROWSER_SAFE = ['src/contracts', 'src/client']
const BUILTINS = [
  'assert',
  'buffer',
  'child_process',
  'crypto',
  'events',
  'fs',
  'fs/promises',
  'http',
  'https',
  'net',
  'os',
  'path',
  'readline',
  'stream',
  'stream/promises',
  'string_decoder',
  'timers',
  'timers/promises',
  'url',
  'util',
  'zlib',
  'worker_threads',
  'cluster',
  'inspector',
  'vm',
  'dgram',
  'tls',
  'http2',
]

const checks = [
  { re: /\bBun\./, msg: 'Bun.* global' },
  { re: /from\s+['"]bun(:|['"])/, msg: 'bun / bun:* import' },
  { re: /process\.versions\.bun/, msg: 'runtime branching on process.versions.bun' },
  { re: /\.node['"]/, msg: 'native addon (.node)' },
  { re: /from\s+['"]node:worker_threads['"]/, msg: 'worker_threads (incomplete under Bun)' },
  {
    re: new RegExp(`from\\s+['"](${BUILTINS.join('|')})['"]`),
    msg: 'bare builtin import — use node: prefix',
  },
]

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (/\.(ts|mts|js|mjs)$/.test(name)) yield p
  }
}

const failures = []
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file)
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return // comments may mention forbidden things
    for (const { re, msg } of checks) if (re.test(line)) failures.push(`${rel}:${i + 1}: ${msg}`)
    if (BROWSER_SAFE.some((d) => rel.startsWith(d)) && /from\s+['"]node:/.test(line))
      failures.push(`${rel}:${i + 1}: node:* import in a browser-safe folder`)
  })
}

if (failures.length) {
  console.error('Runtime-agnostic gate failed:\n' + failures.map((f) => `  ${f}`).join('\n'))
  process.exit(1)
}
console.log('runtime-agnostic: ok')
