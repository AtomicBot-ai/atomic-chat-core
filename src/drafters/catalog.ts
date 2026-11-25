import type { AtomicModelCatalog } from '../client/index.js'
import { hfResolveUrl, inspectRemoteGguf } from '../models/index.js'

export interface Drafter {
  sha256: string
  target: string
  repo: string
  revision: string
  file: string
  size: number
  quant: string
  moreVariants?: boolean
  targetSize?: number
  targetSha256?: string
}

export const repoId = (id: unknown): id is string =>
  typeof id === 'string' && /^[\w-][\w.-]*\/[\w-][\w.-]*$/.test(id)
export const fileId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)
function valid(d: Drafter) {
  return (
    repoId(d.repo) &&
    repoId(d.target) &&
    /^[a-f0-9]{40}$/.test(d.revision) &&
    fileId(d.sha256) &&
    Number.isSafeInteger(d.size) &&
    d.size > 0 &&
    /\.gguf(?:_file)?$/i.test(d.file) &&
    d.file.split('/').every((p) => p && p !== '.' && p !== '..' && !p.includes('\\'))
  )
}
export function curatedDrafters(catalog: Pick<AtomicModelCatalog, 'models'>): Drafter[] {
  return Object.values(catalog.models).flatMap((entry) => {
    if (entry.kind !== 'auxiliary' || entry.definition.method !== 'dspark') return []
    const { target, repo, revision, quant, target_sha256 } = entry.definition
    return (entry.files ?? [])
      .map((f) => ({
        target: String(target),
        repo: String(repo),
        revision: String(revision),
        quant: String(quant),
        file: f.path,
        size: f.size,
        sha256: String(f.sha256),
        targetSize: Number(entry.definition.target_size),
        targetSha256: String(target_sha256),
      }))
      .filter(valid)
  })
}

interface Publication {
  id: string
  sha: string
  tags?: string[]
  cardData?: { base_model?: unknown; target_model?: unknown; dspark_targets?: Record<string, unknown> }
  siblings?: { rfilename: string; size?: number; lfs?: { sha256: string } }[]
}
/** Only an explicit quantization relationship identifies the original checkpoint. */
export function quantizedFrom(tags: unknown): string | undefined {
  if (!Array.isArray(tags)) return
  const bases = tags
    .filter((tag): tag is string => typeof tag === 'string' && tag.startsWith('base_model:quantized:'))
    .map((tag) => tag.slice('base_model:quantized:'.length))
  return bases.length === 1 && repoId(bases[0]) ? bases[0] : undefined
}

export function catalogCheckpointSources(catalog: Pick<AtomicModelCatalog, 'models'>) {
  const sources = new Map<string, string>()
  for (const entry of Object.values(catalog.models)) {
    if (entry.kind === 'auxiliary' && entry.definition.method === 'dspark') {
      const { target_repo, target } = entry.definition
      if (repoId(target_repo) && repoId(target)) sources.set(target_repo.toLowerCase(), target)
    }
    const source = entry.definition.model_name
    const target = quantizedFrom(entry.metadata?.tags)
    if (entry.kind === 'chat' && repoId(source) && target) sources.set(source.toLowerCase(), target)
  }
  return sources
}
export interface CheckpointFile {
  size: number
  sha256: string
  source: string
  target: string
}
/** Identify a pre-existing GGUF even when its installation predates source_repo. */
export function catalogCheckpointFiles(catalog: Pick<AtomicModelCatalog, 'models'>): CheckpointFile[] {
  return Object.values(catalog.models).flatMap((entry) => {
    const source = entry.definition.model_name
    const target = quantizedFrom(entry.metadata?.tags)
    if (entry.kind !== 'chat' || !repoId(source) || !target) return []
    return (entry.files ?? []).flatMap((file) =>
      file.path.endsWith('.gguf') && fileId(file.sha256)
        ? [{ size: file.size, sha256: file.sha256, source, target }]
        : []
    )
  })
}
const draftName = /dspark/i
const ggufFile = /\.gguf(?:_file)?$/i
const normalized = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '')
function onlyRepoId(value: unknown): string | undefined {
  const id = Array.isArray(value) && value.length === 1 ? value[0] : value
  return repoId(id) ? id : undefined
}

/** Mixed conversions can include unrelated experimental heads. Only attribute a co-packaged
 * head to the declared quantization source when the full file stem names that checkpoint. */
function matchesCheckpoint(file: string, checkpoint: string) {
  const stem = file
    .split('/')
    .pop()!
    .replace(ggufFile, '')
    .replace(/(?:[-_.](?:I?Q\d[\w]*|BF16|F16|F32))?(?:[-_.]mainline)?$/i, '')
    .replace(/(?:^dspark[-_.]|[-_.]dspark$)/gi, '')
  return normalized(stem) === normalized(checkpoint.split('/')[1]!)
}
type DiscoveryPage = { results: Drafter[]; partial: boolean }
export class DrafterDiscovery {
  private cache = new Map<string, { until: number; pending: Promise<DiscoveryPage> }>()
  private feeds = new Map<string, { until: number; pending: Promise<{ id: string }[]> }>()
  private heads = new Map<string, Promise<boolean>>()

  constructor(
    private request: typeof fetch,
    private onFound?: (row: Drafter) => void
  ) {}
  trust(rows: Drafter[]) {
    for (const row of rows) this.heads.set(row.sha256, Promise.resolve(true))
  }
  private async json<T>(url: string): Promise<T> {
    const response = await this.request(url, { signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error(`Hugging Face returned ${response.status}`)
    return (await response.json()) as T
  }
  private info(repo: string) {
    return this.json<Publication>('https://huggingface.co/api/models/' + repo + '?blobs=true')
  }
  async checkpoint(repo: string) {
    if (!repoId(repo)) return undefined
    const info = await this.info(repo)
    return quantizedFrom(info.tags) ?? repo
  }
  private async verifier(repo: string, rev: string) {
    const config = await this.json<{
      speculators_config?: { algorithm?: string; verifier?: { name_or_path?: string } }
    }>(hfResolveUrl(repo, 'config.json', rev)).catch(() => undefined)
    const spec = config?.speculators_config
    if (spec?.algorithm === 'dspark' && repoId(spec.verifier?.name_or_path)) return spec.verifier.name_or_path
    // Some publishers declare their verifier in the model card's Target model table.
    const response = await this.request(hfResolveUrl(repo, 'README.md', rev), {
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) return
    const markdown = await response.text()
    const links = [
      ...markdown.matchAll(
        /^\s*(?:\|\s*|[-*]\s*)?(?:\*\*)?(?:Target model|Verifier model)(?:\*\*)?\s*[:|]\s*\[.*?\]\(https:\/\/huggingface\.co\/([\w.-]+\/[\w.-]+)\/?\)/gim
      ),
    ]
    const targets = [...new Set(links.map((m) => m[1]).filter(repoId))]
    return targets.length === 1 ? targets[0] : undefined
  }
  private isHead(d: Drafter) {
    const cached = this.heads.get(d.sha256)
    if (cached) return cached
    const pending = inspectRemoteGguf(hfResolveUrl(d.repo, d.file, d.revision), {
      fetch: this.request,
      timeoutMs: 25000,
      streamPrefix: true,
    })
      .then((e) => !!e.hasDsparkHead)
      .catch((e) => {
        this.heads.delete(d.sha256)
        throw e
      })
    if (this.heads.size >= 1500) this.heads.delete(this.heads.keys().next().value as string)
    this.heads.set(d.sha256, pending)
    return pending
  }
  private async fromRepo(
    repo: string,
    target: string | undefined,
    preview: boolean,
    query: string
  ): Promise<DiscoveryPage> {
    const info = await this.info(repo)
    const results: Drafter[] = []
    let partial = false
    const dedicated = draftName.test(repo)
    const files = (info.siblings ?? []).filter(
      (f) => ggufFile.test(f.rfilename) && (dedicated || draftName.test(f.rfilename))
    )
    if (!files.length || !/^[a-f0-9]{40}$/.test(info.sha)) return { results, partial }
    const origin = quantizedFrom(info.tags) ?? (dedicated ? onlyRepoId(info.cardData?.base_model) : undefined)
    let declared = onlyRepoId(info.cardData?.target_model)
    if (!declared && dedicated && !info.cardData?.dspark_targets) {
      const fromHead = origin && draftName.test(origin)
      declared = await this.verifier(fromHead ? origin : repo, fromHead ? 'main' : info.sha).catch(
        () => undefined
      )
    }
    const candidates: Drafter[] = []
    for (const f of files) {
      const targetId =
        info.cardData?.dspark_targets?.[f.rfilename] ??
        declared ??
        (origin && !draftName.test(origin) && matchesCheckpoint(f.rfilename, origin) ? origin : undefined)
      if (!repoId(targetId) || (target && target.toLowerCase() !== targetId.toLowerCase())) continue
      const row = {
        repo,
        target: targetId,
        revision: info.sha,
        file: f.rfilename,
        size: f.size ?? 0,
        sha256: f.lfs?.sha256 ?? '',
        quant:
          f.rfilename.match(/(?:^|[-.])((?:I?Q\d[\w]*|BF16|F16|F32))(?:-mainline)?\.gguf(?:_file)?$/i)?.[1] ??
          'GGUF',
      }
      if (valid(row) && !candidates.some((d) => d.sha256 === row.sha256)) candidates.push(row)
    }
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const score = (row: Drafter) =>
      (row.quant === 'Q8_0' ? 2 : row.quant === 'Q4_K_M' ? 1 : 0) + (row.file.endsWith('.gguf') ? 1 : 0)
    const ordered = candidates
      .filter((d) =>
        terms.every((t) => [d.file, d.quant, d.repo, d.target].join(' ').toLowerCase().includes(t))
      )
      .sort((a, b) => score(b) - score(a))
    // Show a verified representative per checkpoint. The variant picker inspects the remaining files on demand.
    const seen = new Set<string>()
    const width = preview ? 1 : 3
    for (let i = 0; i < ordered.length; i += width) {
      const batch = ordered.slice(i, i + width).filter((d) => !preview || !seen.has(d.target))
      await Promise.all(
        batch.map(async (d) => {
          try {
            if (!(await this.isHead(d))) return
            seen.add(d.target)
            const row =
              preview && candidates.some((other) => other.target === d.target && other.sha256 !== d.sha256)
                ? { ...d, moreVariants: true }
                : d
            results.push(row)
            this.onFound?.(row)
          } catch {
            partial = true
          }
        })
      )
    }
    return { results, partial }
  }
  variants(repo: string, target: string) {
    return this.cachedRepo(repo, target, false, '')
  }
  private cachedRepo(repo: string, target: string | undefined, preview: boolean, query: string) {
    const key = JSON.stringify([repo, target, preview, query])
    const hit = this.cache.get(key)
    if (hit && hit.until > Date.now()) return hit.pending
    const pending = this.fromRepo(repo, target, preview, query)
      .then((page) => {
        if (page.partial) this.cache.delete(key)
        return page
      })
      .catch((error) => {
        this.cache.delete(key)
        throw error
      })
    if (this.cache.size >= 256) this.cache.delete(this.cache.keys().next().value as string)
    this.cache.set(key, { until: Date.now() + 300_000, pending })
    return pending
  }
  private feed(filter: string, search = '', checkFiles = false) {
    const query = new URLSearchParams({ filter, search, limit: '1000', sort: 'downloads' })
    if (checkFiles) query.set('expand', 'siblings')
    const params = query.toString()
    const cached = this.feeds.get(params)
    if (cached && cached.until > Date.now()) return cached.pending
    const pending = this.json<Pick<Publication, 'id' | 'siblings'>[]>(
      'https://huggingface.co/api/models?' + params
    )
      .then((rows) =>
        rows
          .filter(
            (row) =>
              !checkFiles ||
              !row.siblings ||
              draftName.test(row.id) ||
              row.siblings.some((f) => ggufFile.test(f.rfilename) && draftName.test(f.rfilename))
          )
          .map((row) => ({ id: row.id }))
      )
      .catch((e) => {
        this.feeds.delete(params)
        throw e
      })
    if (this.feeds.size >= 64) this.feeds.delete(this.feeds.keys().next().value as string)
    this.feeds.set(params, { until: Date.now() + 300_000, pending })
    return pending
  }
  async search(target?: string, source?: string, query = '', page = 0) {
    const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
    const term =
      target?.split('/')[1] ?? words.find((w) => !/^(?:dspark|gguf|i?q\d[\w]*|bf16|f16|f32)$/i.test(w))
    const feeds = [this.feed('gguf', 'dspark'), this.feed('gguf,dspark')]
    if (term) feeds.unshift(this.feed('gguf', term, !!target))
    const lists = await Promise.allSettled(feeds)
    let partial = lists.some((v) => v.status === 'rejected')
    // Interleave ranked feeds so co-published heads appear alongside dedicated repositories on page one.
    const ranked = lists.flatMap((v) => (v.status === 'fulfilled' ? [v.value] : []))
    const ids: string[] = []
    const longest = Math.max(0, ...ranked.map((list) => list.length))
    for (let i = 0; i < longest; i++)
      for (const list of ranked) {
        const id = list[i]?.id
        if (repoId(id)) ids.push(id)
      }
    const matching = (id: string) => !term || normalized(id).includes(normalized(term))
    const repos = [...new Set([...(source ? [source] : []), ...ids.filter(matching)])]
    // A model-scoped page inspects all matching files per repository, up to three at a time.
    const n = target ? 3 : 10
    const batch = repos.slice(page * n, (page + 1) * n)
    const checked = await Promise.allSettled(
      batch.map((repo) => this.cachedRepo(repo, target, !target, query))
    )
    const results = checked.flatMap((v) => {
      if (v.status === 'rejected') {
        partial = true
        return []
      }
      partial ||= v.value.partial
      return v.value.results
    })
    return { results, partial, hasMore: repos.length > (page + 1) * n }
  }
}
