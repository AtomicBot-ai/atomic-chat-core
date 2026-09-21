#!/usr/bin/env node
// Compile the CLI into single binaries with Bun. This is the ONLY place the runtime choice lives:
// swapping Bun for Node SEA means editing this file, not src/.
//
//   node scripts/build-binaries.mjs --host   # current platform only
//   node scripts/build-binaries.mjs --all    # all four targets (cross-compile)
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const ENTRY = join(ROOT, 'src/cli/bin.ts')
const APP_ENTRY = join(ROOT, 'src/app-daemon.ts')
const OUT_DIR = join(ROOT, 'dist/bin')

// Bun target → Tauri externalBin triple used by the app (scripts/download-bin.mjs).
const TARGETS = {
  'bun-darwin-arm64': 'aarch64-apple-darwin',
  'bun-darwin-x64': 'x86_64-apple-darwin',
  'bun-windows-x64': 'x86_64-pc-windows-msvc',
  'bun-linux-x64': 'x86_64-unknown-linux-gnu',
}

function hostTarget() {
  const { platform, arch } = process
  if (platform === 'darwin') return arch === 'arm64' ? 'bun-darwin-arm64' : 'bun-darwin-x64'
  if (platform === 'win32') return 'bun-windows-x64'
  if (platform === 'linux') return 'bun-linux-x64'
  throw new Error(`unsupported host ${platform}/${arch}`)
}

// Error reporting (docs/decisions/2026-09-21-report-core-errors-to-its-own-sentry-project.md): the
// release build bakes the Sentry DSN into the app's binary only; the CLI binary never reports.
// Without the variable (local builds) nothing is baked and the binary reports nowhere.
const SENTRY_DSN = process.env.ATOMIC_CORE_SENTRY_DSN?.trim()
const SENTRY_ENVIRONMENT = process.env.ATOMIC_CORE_SENTRY_ENVIRONMENT?.trim() || 'production'
const GIT_SHA = (process.env.ATOMIC_CORE_GIT_SHA ?? process.env.GITHUB_SHA ?? '').trim()

function telemetryDefines() {
  if (!SENTRY_DSN) return []
  const define = (name, value) => ['--define', `${name}=${JSON.stringify(value)}`]
  return [
    ...define('__ATOMIC_CORE_SENTRY_DSN__', SENTRY_DSN),
    ...define('__ATOMIC_CORE_SENTRY_ENVIRONMENT__', SENTRY_ENVIRONMENT),
    ...(GIT_SHA ? define('__ATOMIC_CORE_GIT_SHA__', GIT_SHA) : []),
  ]
}

/** A DSN that silently failed to reach the binary would ship a release that reports nothing. */
function assertDsnBaked(outfile) {
  const host = new URL(SENTRY_DSN).host
  if (!readFileSync(outfile).includes(host)) {
    console.error(`${outfile} does not contain the Sentry DSN (${host}); refusing to ship it`)
    process.exit(1)
  }
}

const all = process.argv.includes('--all')
const targets = all ? Object.keys(TARGETS) : [hostTarget()]
mkdirSync(OUT_DIR, { recursive: true })

for (const target of targets) {
  const triple = TARGETS[target]
  for (const [name, entry] of [
    ['atomic-chat-core', ENTRY],
    ['atomic-chat-app-core', APP_ENTRY],
  ]) {
    const outfile = join(OUT_DIR, `${name}-${triple}${target.includes('windows') ? '.exe' : ''}`)
    const reports = name === 'atomic-chat-app-core'
    const args = [
      'build',
      '--compile',
      `--target=${target}`,
      // Identifiers are kept: error reports group by function name, and minified names change with
      // every release. The embedded source map already turns frames back into `src/…:line:col`.
      '--minify-syntax',
      '--minify-whitespace',
      '--sourcemap',
      ...(reports ? telemetryDefines() : []),
      entry,
      '--outfile',
      outfile,
    ]
    // The DSN is not a secret (every shipped binary carries it), but the log need not repeat it.
    console.log(`bun ${args.join(' ').replace(SENTRY_DSN || '\0', '<dsn>')}`)
    const res = spawnSync('bun', args, { stdio: 'inherit', cwd: ROOT })
    if (res.status !== 0) {
      console.error(`build failed for ${target}: ${name}`)
      process.exit(res.status ?? 1)
    }
    if (reports && SENTRY_DSN) assertDsnBaked(outfile)
  }
}
console.log(`built ${targets.length * 2} binaries into dist/bin`)
