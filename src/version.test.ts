import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CORE_VERSION } from './version.js'

describe('CORE_VERSION', () => {
  it('matches package.json', () => {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }
    expect(CORE_VERSION).toBe(pkg.version)
  })
})
