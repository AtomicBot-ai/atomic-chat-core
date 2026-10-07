/**
 * The PrismML model rules, I/O half: live conf document → memory (`PRISM_MODEL_RULES_TTL_MS`) →
 * `<data>/atomic-prism/model-rules.cache.json` → the bundled baseline. A live document with an older
 * `rules_version` than the baseline is ignored (a stale CDN copy must not undo a shipped fix).
 * Concurrent callers share one fetch. Never throws.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DataLayout } from '../../config/index.js'
import { PRISM_MODEL_RULES_BASELINE } from './rules-baseline.js'
import { parsePrismModelRules, PRISM_MODEL_RULES_URL } from './rules.js'
import type { PrismModelRules } from './rules.js'

export const PRISM_MODEL_RULES_TTL_MS = 60 * 60 * 1000
export const PRISM_MODEL_RULES_FETCH_TIMEOUT_MS = 8_000

export interface PrismModelRulesServiceDeps {
  layout: DataLayout
  fetch: typeof fetch
  now?: () => number
  url?: string
  baseline?: PrismModelRules
  timeoutMs?: number
  log?: (level: 'info' | 'warn', message: string) => void
}

export function prismModelRulesCachePath(layout: DataLayout): string {
  return join(layout.provider('atomic-prism').root, 'model-rules.cache.json')
}

export class PrismModelRulesService {
  private memory: { fetchedAt: number; rules: PrismModelRules } | null = null
  private inFlight: Promise<PrismModelRules> | null = null

  constructor(private readonly deps: PrismModelRulesServiceDeps) {}

  /** The rules to decide with now; `force` skips the memory copy. */
  async rules(options: { force?: boolean } = {}): Promise<PrismModelRules> {
    const now = this.deps.now ?? Date.now
    if (!options.force && this.memory && now() - this.memory.fetchedAt < PRISM_MODEL_RULES_TTL_MS) {
      return this.memory.rules
    }
    if (this.inFlight) return this.inFlight
    this.inFlight = this.resolve().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  /** The rules without touching the network: memory, disk, baseline. For the load gate. */
  async cachedRules(): Promise<PrismModelRules> {
    if (this.memory) return this.memory.rules
    return this.newest(await this.readDiskCache())
  }

  private newest(candidate: PrismModelRules | null): PrismModelRules {
    const baseline = this.deps.baseline ?? PRISM_MODEL_RULES_BASELINE
    return candidate && candidate.rules_version >= baseline.rules_version ? candidate : baseline
  }

  private async resolve(): Promise<PrismModelRules> {
    const now = this.deps.now ?? Date.now
    const url = this.deps.url ?? PRISM_MODEL_RULES_URL
    try {
      const controller = new AbortController()
      const timer = setTimeout(
        () => controller.abort(),
        this.deps.timeoutMs ?? PRISM_MODEL_RULES_FETCH_TIMEOUT_MS
      )
      let body: unknown
      try {
        const response = await this.deps.fetch(url, {
          headers: { 'Accept': 'application/json', 'User-Agent': 'atomic-chat' },
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`${url} returned ${response.status}`)
        body = await response.json()
      } finally {
        clearTimeout(timer)
      }
      const parsed = parsePrismModelRules(body)
      if (!parsed) throw new Error(`${url} is not a rules document this core understands`)
      const rules = this.newest(parsed)
      this.memory = { fetchedAt: now(), rules }
      if (rules === parsed) await this.writeDiskCache(parsed, now())
      return rules
    } catch (err) {
      this.deps.log?.(
        'warn',
        `[prism-rules] live rules unavailable: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    const rules = this.newest(await this.readDiskCache())
    this.memory = { fetchedAt: now(), rules }
    return rules
  }

  private async readDiskCache(): Promise<PrismModelRules | null> {
    try {
      const raw = JSON.parse(await readFile(prismModelRulesCachePath(this.deps.layout), 'utf8')) as unknown
      return raw && typeof raw === 'object'
        ? parsePrismModelRules((raw as Record<string, unknown>)['rules'])
        : null
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.deps.log?.('warn', `[prism-rules] failed to read disk cache: ${String(err)}`)
      }
      return null
    }
  }

  private async writeDiskCache(rules: PrismModelRules, fetchedAt: number): Promise<void> {
    const path = prismModelRulesCachePath(this.deps.layout)
    const temporary = `${path}.tmp-${process.pid}-${fetchedAt}`
    try {
      await mkdir(this.deps.layout.provider('atomic-prism').root, { recursive: true })
      await writeFile(temporary, JSON.stringify({ fetched_at: fetchedAt, rules }), 'utf8')
      await rename(temporary, path)
    } catch (err) {
      await rm(temporary, { force: true }).catch(() => {})
      this.deps.log?.('warn', `[prism-rules] failed to write disk cache: ${String(err)}`)
    }
  }
}
