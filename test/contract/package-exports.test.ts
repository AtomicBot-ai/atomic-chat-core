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
    expect(Object.keys(pkg.exports)).toEqual([
      '.',
      './client',
      './contracts',
      './host',
      './models',
      './foundry-host',
      './settings',
    ])
  })

  it('refuses to resolve @atomic-chat/core/downloads and resolves ./models', async () => {
    const resolved = await resolveFromPackage(['@atomic-chat/core/downloads', '@atomic-chat/core/models'])
    expect(resolved['@atomic-chat/core/downloads']).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED')
    expect(resolved['@atomic-chat/core/models']).toMatch(/\/dist\/models\/index\.js$/)
  })

  // It imports every entry point's whole module graph, cold: past the 5 s default on Windows runners.
  it(
    'keeps ModelRegistry and fetchHfGgufFiles in ./models, and no entry point hands out the downloader',
    { timeout: 60_000 },
    async () => {
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
    }
  )

  it('re-exports nothing from the downloads module directly, types included', async () => {
    for (const entry of [
      'index.ts',
      'client/index.ts',
      'contracts/index.ts',
      'host/index.ts',
      'models/index.ts',
    ]) {
      const text = await readFile(new URL(`src/${entry}`, ROOT), 'utf8')
      // Any specifier into src/downloads: `./downloads`, `../downloads/index.js`, `./downloads.js`.
      expect(text, entry).not.toMatch(/from ['"][^'"]*\bdownloads(\.js|\/[^'"]*)?['"]/)
    }
  })

  // The entry a program that embeds the core (`atc`) hands `foundry-host …` to (change
  // close-cli-core-gaps, design D1). Importing it under Node must not touch `bun:ffi`: this test runs
  // under Node, where a static `bun:ffi` anywhere in its graph fails the import itself.
  it('resolves ./foundry-host to its own entry, which imports under Node', async () => {
    const resolved = await resolveFromPackage(['@atomic-chat/core/foundry-host'])
    expect(resolved['@atomic-chat/core/foundry-host']).toMatch(
      /\/dist\/runtime\/foundry-local\/foundry-host\.js$/
    )
    // What the entry does is `src/runtime/foundry-local/foundry-host.test.ts`; here, that it is the one export.
    const entry = (await import('../../src/runtime/foundry-local/foundry-host.js')) as Record<string, unknown>
    expect(Object.keys(entry)).toEqual(['runFoundryHostMain'])
  })

  // Provider setting schemas for a program that embeds the core (change close-cli-core-gaps, design D3):
  // `settingsSchema` and `LOCAL_PROVIDER_IDS` only, not the store behind `src/settings/index.ts`, and
  // no deep path into the package's sources.
  it('resolves ./settings to the schemas alone and publishes no source schema files', async () => {
    const resolved = await resolveFromPackage(['@atomic-chat/core/settings'])
    expect(resolved['@atomic-chat/core/settings']).toMatch(/\/dist\/settings\/public\.js$/)
    const entry = (await import('../../src/settings/public.js')) as Record<string, unknown>
    expect(Object.keys(entry).sort()).toEqual(['LOCAL_PROVIDER_IDS', 'settingsSchema'])
    const settingsSchema = entry['settingsSchema'] as (provider: string) => unknown[]
    expect(entry['LOCAL_PROVIDER_IDS']).toContain('atomic-prism')
    expect(settingsSchema('atomic-prism').length).toBeGreaterThan(0)
    const pkg = JSON.parse(await readFile(new URL('package.json', ROOT), 'utf8')) as { files: string[] }
    expect(pkg.files.filter((f) => f.startsWith('src'))).toEqual([])
  })

  // `atc` reads its data folder's ACL with the executor's own query and judge (change close-cli-core-gaps, D5).
  it('hands out readWindowsAcl and judgeWindowsAcl from ./host', { timeout: 60_000 }, async () => {
    const host = (await import('../../src/host/index.js')) as Record<string, unknown>
    expect(typeof host['readWindowsAcl']).toBe('function')
    expect(typeof host['judgeWindowsAcl']).toBe('function')
  })
})
