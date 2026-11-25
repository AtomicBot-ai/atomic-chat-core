import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AtomicCoreError } from '../contracts/index.js'
import type { Downloader } from '../downloads/index.js'
import { sha256File } from '../downloads/index.js'
import { hfResolveUrl, inspectLocalGguf, readGgufMetadataFromFile } from '../models/index.js'
import type { ModelRegistry } from '../models/index.js'
import { DrafterDiscovery, fileId, repoId, type CheckpointFile, type Drafter } from './catalog.js'

async function optionalJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
}
async function save(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = path + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, JSON.stringify(value))
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}
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
  private readonly transfers = new Map<string, Promise<void>>()
  private readonly verified = new Map<string, string>()
  private readonly discovery: DrafterDiscovery
  private tail: Promise<unknown> = Promise.resolve()
  constructor(
    private root: string,
    private registry: ModelRegistry,
    private downloader: Downloader,
    request: typeof fetch,
    readonly curated: Drafter[],
    private restart: Restart,
    private remoteCatalog?: () => Promise<Drafter[]>,
    private knownSources = new Map<string, string>(),
    private checkpointFiles: CheckpointFile[] = []
  ) {
    this.discovery = new DrafterDiscovery(request, (row) => this.remember([row]))
    this.discovery.trust(curated)
    this.remember(curated)
  }
  remember(rows: Drafter[]) {
    for (const row of rows) {
      const stored = this.entries.get(row.sha256)
      if (!stored) this.entries.set(row.sha256, row)
      else if (row.moreVariants && row.repo === stored.repo && row.target === stored.target)
        this.entries.set(row.sha256, { ...stored, moreVariants: true })
    }
  }
  private exclusive<T>(fn: () => Promise<T>) {
    const result = this.tail.then(fn, fn)
    this.tail = result.catch(() => {})
    return result
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
    let rows = [...this.entries.values()]
    if (live) {
      try {
        const found = await this.discovery.search(target, source, query, page)
        this.remember(found.results)
        rows = [...this.entries.values()]
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
    return { target, partial, hasMore, results: [...new Map(filtered.map((d) => [d.sha256, d])).values()] }
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
    await this.exclusive(async () => {
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
    const info = await stat(path)
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
  private async identity(model: string) {
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
    if (target)
      await save(ctx.settings, { id: ctx.binding?.id ?? null, signature: ctx.signature, target, source })
    return { ...ctx, target, source }
  }
  async choices(model: string) {
    return this.exclusive(async () => {
      const ctx = await this.identity(model)
      const files = (await this.inventory()).filter(
        (d) => d.target.toLowerCase() === ctx.target?.toLowerCase()
      )
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
      (f) => f.sha256 === binding.id && f.target.toLowerCase() === binding.target?.toLowerCase()
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
    return this.exclusive(() => this.change(model, id))
  }
  private async change(model: string, id: string | null) {
    const ctx =
      id === null
        ? { ...(await this.context(model)), target: undefined, source: undefined }
        : await this.identity(model)
    if (
      id !== null &&
      !(await this.inventory()).some(
        (d) => d.sha256 === id && d.target.toLowerCase() === ctx.target?.toLowerCase()
      )
    )
      throw new AtomicCoreError('INVALID_ARGUMENT', 'This drafter is not installed for this checkpoint.')
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
    return this.exclusive(async () => {
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
