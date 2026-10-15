/**
 * The npm package's subpaths are a contract with the app and `atc`. The core does not download model
 * files (ADR 2026-10-15-core-does-not-download-models), so no subpath hands out the downloader:
 * `./downloads` is not exported, and neither the other entry points nor `./models` re-export it.
 * Resolution goes through Node's package self-reference, which reads `exports` from package.json and
 * needs no build.
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const ROOT = new URL('../../', import.meta.url)
const run = promisify(execFile)

/** What `import.meta.resolve` says for each specifier, from inside the package: a URL or an error code. */
async function resolveFromPackage(specifiers: string[]): Promise<Record<string, string>> {
  const script = `
    const out = {}
    for (const s of ${JSON.stringify(specifiers)}) {
      try { out[s] = import.meta.resolve(s) } catch (e) { out[s] = e.code ?? String(e) }
    }
    console.log(JSON.stringify(out))
  `
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT,
  })
  return JSON.parse(stdout) as Record<string, string>
}

describe('package exports', () => {
  it('exports exactly the public subpaths, without ./downloads', async () => {
    const pkg = JSON.parse(await readFile(new URL('package.json', ROOT), 'utf8')) as {
      exports: Record<string, unknown>
    }
    expect(Object.keys(pkg.exports)).toEqual(['.', './client', './contracts', './host', './models'])
  })

  it('refuses to resolve @atomic-chat/core/downloads and resolves ./models', async () => {
    const resolved = await resolveFromPackage(['@atomic-chat/core/downloads', '@atomic-chat/core/models'])
    expect(resolved['@atomic-chat/core/downloads']).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED')
    expect(resolved['@atomic-chat/core/models']).toMatch(/\/dist\/models\/index\.js$/)
  })

  it('keeps ModelRegistry and fetchHfGgufFiles in ./models, and no entry point hands out the downloader', async () => {
    const entries = {
      '.': await import('../../src/index.js'),
      './client': await import('../../src/client/index.js'),
      './contracts': await import('../../src/contracts/index.js'),
      './host': await import('../../src/host/index.js'),
      './models': await import('../../src/models/index.js'),
    }
    const models = entries['./models'] as Record<string, unknown>
    expect(typeof models['ModelRegistry']).toBe('function')
    expect(typeof models['fetchHfGgufFiles']).toBe('function')
    expect(models).not.toHaveProperty('downloadHfModel')
    for (const [entry, module] of Object.entries(entries)) {
      expect(module, entry).not.toHaveProperty('Downloader')
      expect(module, entry).not.toHaveProperty('downloadSegments')
    }
  })

  it('re-exports nothing from the downloads module, types included', async () => {
    for (const entry of [
      'index.ts',
      'client/index.ts',
      'contracts/index.ts',
      'host/index.ts',
      'models/index.ts',
    ]) {
      const text = await readFile(new URL(`src/${entry}`, ROOT), 'utf8')
      expect(text, entry).not.toMatch(/from ['"][./]*downloads(\/[^'"]*)?['"]/)
    }
  })
})
