import { randomUUID } from 'node:crypto'
import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fastFlowLmSources, readAtomicDocument } from '../../../client/index.js'
import type { Sha256Digest } from '../../../contracts/index.js'
import { AsyncMutex } from '../../../diffusion/index.js'
import { canonicalDigest } from '../../environment/index.js'
import { parseEnvironment, type FlmManifest, type FlmPlatform } from './manifest.js'

interface Options {
  cache: string
  platform: FlmPlatform
  env: NodeJS.ProcessEnv
  fetch?: typeof fetch
}
interface Entry {
  source: string
  digest: Sha256Digest
  manifest: FlmManifest
}

/** A single owner writes this platform's history under its existing data-folder lock. A rename
 * publishes the document, source pointer and immutable recipe identities in one filesystem step. */
export class EnvironmentManifestStore {
  private readonly lock = new AsyncMutex()
  private readonly path: string
  constructor(private readonly options: Options) {
    this.path = join(options.cache, 'environment-' + options.platform + '.json')
  }
  private async history(): Promise<Entry[]> {
    let raw
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw e
    }
    const entries: unknown = JSON.parse(raw)
    if (!Array.isArray(entries)) throw Error('Invalid FLM environment cache')
    return entries.map((entry) => {
      const manifest = parseEnvironment(entry.manifest, this.options.platform)
      if (typeof entry.source !== 'string' || canonicalDigest(manifest) !== entry.digest)
        throw Error('Invalid FLM environment cache digest')
      return { source: entry.source, manifest, digest: entry.digest }
    })
  }
  async pinned(digest: Sha256Digest): Promise<FlmManifest | null> {
    return (await this.history().catch(() => [])).find((entry) => entry.digest === digest)?.manifest ?? null
  }
  latest(): Promise<FlmManifest | null> {
    return this.lock.run(async () => {
      const { platform, env, cache } = this.options
      let url, history
      try {
        const override = env.ATOMIC_FASTFLOWLM_ENVIRONMENT_MANIFEST_URL
        url = fastFlowLmSources(
          platform === 'windows' ? 'win32' : 'linux',
          override === undefined ? {} : { ATOMIC_FASTFLOWLM_ENVIRONMENT_MANIFEST_URL: override }
        ).environment
        history = await this.history()
      } catch {
        return null
      }
      const source = canonicalDigest(url)
      const previous = history.filter((entry) => entry.source === source)
      const fallback = previous.at(-1)?.manifest ?? null
      try {
        const manifest = parseEnvironment(
          await readAtomicDocument(url, {
            fetch: this.options.fetch ?? fetch,
            readLocal: (file) => readFile(fileURLToPath(file), 'utf8'),
          }),
          platform
        )
        const digest = canonicalDigest(manifest)
        if (
          fallback &&
          BigInt(manifest.manifest_id.split('-r').at(-1)!) < BigInt(fallback.manifest_id.split('-r').at(-1)!)
        )
          return fallback
        const existing = previous.find((entry) => entry.manifest.manifest_id === manifest.manifest_id)
        if (existing) return existing.digest === digest ? existing.manifest : fallback
        for (const r of manifest.recipes) {
          const old = previous
            .flatMap((entry) => entry.manifest.recipes)
            .find((other) => other.recipe_id === r.recipe_id && other.revision === r.revision)
          if (old && canonicalDigest(old) !== canonicalDigest(r)) return fallback
        }
        const tmp = this.path + '.' + randomUUID() + '.tmp'
        try {
          await mkdir(cache, { recursive: true })
          await writeFile(tmp, JSON.stringify([...history, { source, digest, manifest }]), {
            flag: 'wx',
            mode: 0o600,
          })
          await rename(tmp, this.path)
        } catch {
          // A newer validated document can withdraw a recipe. Fail closed if it cannot be pinned.
          return null
        } finally {
          await rm(tmp, { force: true }).catch(() => {})
        }
        return manifest
      } catch {
        return fallback
      }
    })
  }
}
