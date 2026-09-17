#!/usr/bin/env node
// Compile the CLI into single binaries with Bun. This is the ONLY place the runtime choice lives:
// swapping Bun for Node SEA means editing this file, not src/.
//
//   node scripts/build-binaries.mjs --host   # current platform only
//   node scripts/build-binaries.mjs --all    # all four targets (cross-compile)
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
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
    const args = [
      'build',
      '--compile',
      `--target=${target}`,
      '--minify',
      '--sourcemap',
      entry,
      '--outfile',
      outfile,
    ]
    console.log(`bun ${args.join(' ')}`)
    const res = spawnSync('bun', args, { stdio: 'inherit', cwd: ROOT })
    if (res.status !== 0) {
      console.error(`build failed for ${target}: ${name}`)
      process.exit(res.status ?? 1)
    }
  }
}
console.log(`built ${targets.length * 2} binaries into dist/bin`)
