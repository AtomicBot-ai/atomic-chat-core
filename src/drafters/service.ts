import { FifoLock } from '../runtime/shared/fifo-lock.js'
import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { optionalJson, save } from './storage.js'
import { AtomicCoreError } from '../contracts/index.js'
import type { Downloader } from '../downloads/index.js'
import { sha256File } from '../downloads/index.js'
import { hfResolveUrl, inspectLocalGguf, readGgufMetadataFromFile } from '../models/index.js'
import type { ModelRegistry } from '../models/index.js'
import { DrafterDiscovery, fileId, repoId, type CheckpointFile, type Drafter } from './catalog.js'

interface Inventory {
  files: Drafter[]
}
interface Binding {
  id: string | null
  target?: string
  signature: string
  source?: string
}
type Restart = (model: string, rollback: () => Promise<void>) => Promise<unknown>

export class DrafterService {
  private readonly entries = new Map<string, Drafter>()
  private readonly publications = new Map<string, Drafter>()
  private readonly transfers = new Map<string, Promise<void>>()
  private readonly verified = new Map<string, string>()
  private readonly discovery: DrafterDiscovery
  constructor(
    private root: string,
    private registry: ModelRegistry,
    private downloader: Downloader,
    request: typeof fetch,
    readonly curated: Drafter[],
    private restart: Restart,
    private remoteCatalog?: () => Promise<Drafter[]>,
    private knownSources = new Map<string, string>(),
    private checkpointFiles: CheckpointFile[] = [],
    private mutations = new FifoLock()
  ) {
    this.discovery = new DrafterDiscovery(request, (row) => this.remember([row]))
    this.discovery.trust(curated)
    this.remember(curated)
  }
  remember(rows: Drafter[]) {
    for (const row of rows) {
      this.publications.set(row.repo.toLowerCase() + ':' + row.sha256 + ':' + row.target.toLowerCase(), row)
      const stored = this.entries.get(row.sha256)
      if (!stored) this.entries.set(row.sha256, row)
      else if (row.target.toLowerCase() !== stored.target.toLowerCase()) {
        const compatibleTargets = [...new Set([...(stored.compatibleTargets ?? []), row.target])]
        this.entries.set(row.sha256, { ...stored, compatibleTargets })
      } else if (row.moreVariants && row.repo === stored.repo)
        this.entries.set(row.sha256, { ...stored, moreVariants: true })
    }
  }
  private get index() {
    return join(this.root, 'llamacpp', 'drafters', 'index.json')
  }
  private path(id: string) {
    if (!fileId(id)) throw new AtomicCoreError('INVALID_ARGUMENT', 'Invalid DSpark artifact ID.')
    return join('llamacpp', 'drafters', id + '.gguf')
  }
  private async inventory() {
    return (await optionalJson<Inventory>(this.index))?.files ?? []
  }
  async list() {
    return {
      files: await this.inventory(),
      downloads: this.downloader.snapshot().filter((d) => d.taskId.startsWith('dspark:')),
    }
  }
  private refreshAt = 0
  async search(source: string | undefined, query: string, live: boolean, knownTarget?: string, page = 0) {
    let target = knownTarget || (source && this.knownSources.get(source.toLowerCase())) || source
    let partial = false
    let hasMore = false
    if (
      source &&
      target === source &&
      !knownTarget &&
      !this.knownSources.has(source.toLowerCase()) &&
      !this.curated.some((d) => d.target.toLowerCase() === source.toLowerCase())
    ) {
      if (live)
        try {
          target = (await this.discovery.checkpoint(source)) ?? source
          this.knownSources.set(source.toLowerCase(), target)
        } catch {
          partial = true
        }
    }
    if (live && this.remoteCatalog && Date.now() > this.refreshAt) {
      this.refreshAt = Date.now() + 3600_000
      try {
        const remote = await this.remoteCatalog()
        this.discovery.trust(remote)
        this.remember(remote)
        for (const row of remote)
          if (!this.curated.some((r) => r.sha256 === row.sha256)) this.curated.push(row)
      } catch {
        this.refreshAt = Date.now() + 60_000
      }
    }
    let rows = [...this.publications.values()]
    if (live) {
      try {
        const found = await this.discovery.search(target, source ?? target, query, page)
        this.remember(found.results)
        rows = [...this.publications.values()]
        partial ||= found.partial
        hasMore = found.hasMore
      } catch {
        partial = true
      }
    }
    rows = [...rows, ...(await this.inventory())]
    const terms = query.toLowerCase().trim().split(/\s+/)
    const filtered = rows.filter(
      (d) =>
        (!target || d.target.toLowerCase() === target.toLowerCase()) &&
        terms.every((term) => [d.target, d.repo, d.file, d.quant].join(' ').toLowerCase().includes(term))
    )
    const preferredRepo = (source ?? target)?.toLowerCase()
    const preferred = (d: Drafter) => Number(d.repo.toLowerCase() === preferredRepo)
    filtered.sort((a, b) => preferred(b) - preferred(a))
    const unique = new Map<string, Drafter>()
    for (const row of filtered) if (!unique.has(row.sha256)) unique.set(row.sha256, row)
    return { target, partial, hasMore, results: [...unique.values()] }
  }
  async variants(repo: string, target: string) {
    return this.discovery.variants(repo, target)
  }
  install(id: string) {
    const existing = this.transfers.get(id)
    if (existing) return existing
    const row = this.entries.get(id)
    if (!row) throw new AtomicCoreError('INVALID_ARGUMENT', 'Refresh the drafter search before downloading.')
    const work = this.download(row).finally(() => this.transfers.delete(id))
    this.transfers.set(id, work)
    return work
  }
  private async download(row: Drafter) {
    if ((await this.inventory()).some((d) => d.sha256 === row.sha256)) {
      const existing = join(this.root, this.path(row.sha256))
      if ((await sha256File(existing).catch(() => undefined)) === row.sha256) return
    }
    const relative = this.path(row.sha256)
    await this.downloader.download(
      'dspark:' + row.sha256,
      [
        {
          url: hfResolveUrl(row.repo, row.file, row.revision),
          save_path: relative,
          sha256: row.sha256,
          size: row.size,
          model_id: 'dspark:' + row.sha256,
        },
      ],
      { resume: true }
    )
    if (!(await inspectLocalGguf(join(this.root, relative))).hasDsparkHead)
      throw new AtomicCoreError(
        'MODEL_FILE_CORRUPT',
        'The downloaded GGUF does not contain a DSpark Markov head.'
      )
    await this.mutations.run(async () => {
      const files = await this.inventory()
      await save(this.index, { files: [...files.filter((f) => f.sha256 !== row.sha256), row] })
    })
  }
  cancel(id: string) {
    this.path(id)
    return this.downloader.cancel('dspark:' + id)
  }
  private installation(model: string) {
    if (
      typeof model !== 'string' ||
      model
        .split('/')
        .some(
          (part) =>
            !part ||
            part === '.' ||
            part === '..' ||
            part.includes('\\') ||
            part.includes(':') ||
            part.includes(String.fromCharCode(0))
        )
    )
      throw new AtomicCoreError('INVALID_ARGUMENT', 'Invalid installed model ID.')
    return this.registry.get(model)
  }
  async selection(model: string) {
    const entry = await this.installation(model)
    const stored = await optionalJson<Binding>(join(entry.dir, 'upstream-drafter.json'))
    if (!stored?.id) return { id: null }
    return { id: (await this.context(model)).binding?.id ?? null }
  }
  private async context(model: string) {
    const { dir, yml } = await this.installation(model)
    const path = this.registry.resolvePaths(yml).modelPath
    const info = await stat(path).catch((error: unknown) => {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR')
        throw new AtomicCoreError('MODEL_FILE_NOT_FOUND', 'The model file is missing.', path)
      throw error
    })
    const signature = JSON.stringify([path, info.size, info.mtimeMs])
    const settings = join(dir, 'upstream-drafter.json')
    const stored = await optionalJson<Binding>(settings)
    return {
      path,
      yml,
      signature,
      settings,
      binding: stored?.signature === signature ? stored : undefined,
      size: info.size,
    }
  }
  private async identity(model: string, cache = true) {
    const ctx = await this.context(model)
    if (ctx.binding?.target) return { ...ctx, target: ctx.binding.target, source: ctx.binding.source }
    const known = this.curated.find((d) => d.targetSha256 && d.targetSha256 === ctx.yml.model_sha256)
    let target = known?.target
    const meta = (await readGgufMetadataFromFile(ctx.path)).metadata
    const published = meta['general.repo_url']?.replace(/^https:\/\/huggingface\.co\//, '').replace(/\/$/, '')
    const snapshot = ctx.path
      .replace(/\\/g, '/')
      .match(/(?:^|\/)models--([\w.-]+)--([\w.-]+)\/snapshots\/[0-9a-f]{40}\//)
    const cachedRepo = snapshot ? snapshot[1] + '/' + snapshot[2] : undefined
    let source = repoId(ctx.yml.source_repo)
      ? ctx.yml.source_repo
      : repoId(cachedRepo)
        ? cachedRepo
        : repoId(published)
          ? published
          : undefined

    if (!target) {
      const candidates = this.curated.filter((d) => d.targetSize === ctx.size)
      const catalogFiles = this.checkpointFiles.filter((f) => f.size === ctx.size)
      if (candidates.length || catalogFiles.length) {
        const hash = ctx.yml.model_sha256 || (await sha256File(ctx.path))
        const match = catalogFiles.find((f) => f.sha256 === hash)
        target = match?.target ?? candidates.find((d) => d.targetSha256 === hash)?.target
        source ??= match?.source
      }
    }
    if (!target && source)
      target =
        this.knownSources.get(source.toLowerCase()) ??
        (await this.discovery.checkpoint(source).catch(() => undefined))
    if (target && source) this.knownSources.set(source.toLowerCase(), target)
    if (target && cache)
      await save(ctx.settings, { id: ctx.binding?.id ?? null, signature: ctx.signature, target, source })
    return { ...ctx, target, source }
  }
  async checkpoint(model: string, previous?: { target: string; signature: string }) {
    if (previous && (await this.context(model)).signature === previous.signature) return previous
    const { target, source, signature } = await this.identity(model, false)
    return { target: target ?? source, source, signature }
  }
  private supports(row: Drafter, target?: string) {
    const known = this.entries.get(row.sha256)
    return [
      row.target,
      ...(row.compatibleTargets ?? []),
      known?.target,
      ...(known?.compatibleTargets ?? []),
    ].some((candidate) => !!candidate && candidate.toLowerCase() === target?.toLowerCase())
  }
  async choices(model: string) {
    return this.mutations.run(async () => {
      const ctx = await this.identity(model)
      const files = (await this.inventory()).filter((d) => this.supports(d, ctx.target))
      return { target: ctx.target, source: ctx.source, id: ctx.binding?.id ?? null, files }
    })
  }
  async resolve(model: string) {
    const entry = await this.installation(model)
    const binding = await optionalJson<Binding>(join(entry.dir, 'upstream-drafter.json'))
    if (!binding?.id) return undefined
    const ctx = await this.context(model)
    if (!ctx.binding?.id) return undefined
    const row = (await this.inventory()).find(
      (f) => f.sha256 === binding.id && this.supports(f, binding.target)
    )
    if (!row)
      throw new AtomicCoreError(
        'MODEL_FILE_NOT_FOUND',
        'Selected DSpark drafter is missing. Select None or download it again.'
      )
    const path = join(this.root, this.path(row.sha256))
    const info = await stat(path).catch(() => undefined)
    const identity = info && JSON.stringify([info.size, info.mtimeMs, info.ctimeMs])
    if (!identity || !info || info.size !== row.size)
      throw new AtomicCoreError('MODEL_FILE_NOT_FOUND', 'Selected DSpark file is missing or incomplete.')
    if (this.verified.get(row.sha256) === identity) return path
    if (!(await inspectLocalGguf(path)).hasDsparkHead || (await sha256File(path)) !== row.sha256)
      throw new AtomicCoreError('MODEL_FILE_CORRUPT', 'Selected DSpark file is invalid.')
    this.verified.set(row.sha256, identity)
    return path
  }
  async select(model: string, id: string | null) {
    return this.mutations.run(() => this.change(model, id))
  }
  private async change(model: string, id: string | null) {
    const ctx =
      id === null
        ? { ...(await this.context(model)), target: undefined, source: undefined }
        : await this.identity(model)
    if (id !== null) {
      const files = await this.inventory()
      const row = files.find((d) => d.sha256 === id)
      if (!row || !ctx.target || !this.supports(row, ctx.target))
        throw new AtomicCoreError('INVALID_ARGUMENT', 'This drafter is not installed for this checkpoint.')
      if (row.target !== ctx.target && !row.compatibleTargets?.includes(ctx.target)) {
        row.compatibleTargets = [...(row.compatibleTargets ?? []), ctx.target]
        await save(this.index, { files })
      }
    }
    const old = ctx.binding ?? { id: null, target: ctx.target, source: ctx.source, signature: ctx.signature }
    if (old.id === id) return
    await save(ctx.settings, { ...old, id })
    const rollback = () => save(ctx.settings, old)
    try {
      if (id) await this.resolve(model)
      await this.restart(model, rollback)
    } catch (e) {
      await rollback()
      throw e
    }
  }
  async remove(id: string) {
    return this.mutations.run(async () => {
      const path = this.path(id)
      if (this.transfers.has(id)) throw new AtomicCoreError('JOB_BUSY', 'Wait for the download to finish.')
      for (const entry of await this.registry.list()) {
        const binding = await optionalJson<Binding>(join(entry.dir, 'upstream-drafter.json'))
        if (binding?.id === id) await this.change(entry.id, null)
      }
      await rm(join(this.root, path), { force: true })
      await save(this.index, { files: (await this.inventory()).filter((d) => d.sha256 !== id) })
    })
  }
}
