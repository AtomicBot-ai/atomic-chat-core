import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Drives the compiled binary produced by `npm run build:bin`. Skips when it has not been built.
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CPU = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
const TRIPLE =
  process.platform === 'darwin'
    ? `${CPU}-apple-darwin`
    : process.platform === 'win32'
      ? `${CPU}-pc-windows-msvc.exe`
      : `${CPU}-unknown-linux-gnu`
const BIN = join(ROOT, 'dist/bin', `atomic-chat-core-${TRIPLE}`)

describe.skipIf(!existsSync(BIN))('compiled binary', () => {
  it('prints its version and exits 0', () => {
    const res = spawnSync(BIN, ['--version'], { encoding: 'utf8' })
    expect(res.status).toBe(0)
    expect(res.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('exits 2 on an unknown command', () => {
    const res = spawnSync(BIN, ['frobnicate'], { encoding: 'utf8' })
    expect(res.status).toBe(2)
    expect(res.stderr).toContain('Usage:')
  })
})
