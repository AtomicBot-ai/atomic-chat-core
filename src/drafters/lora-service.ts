import { FifoLock } from '../runtime/shared/fifo-lock.js'
import { open, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { AtomicCoreError } from '../contracts/index.js'
import { sha256File, type Downloader } from '../downloads/index.js'
import { hfResolveUrl, readGgufMetadataFromFile } from '../models/index.js'
import { fileId } from './catalog.js'
import { optionalJson, save } from './storage.js'
import {
  hasLoraTensors,
  discoverLoras,
  bundledLoras,
  type LoraArtifact,
  type LoraMode,
  type catalogLoras,
} from './lora-catalog.js'

type Catalog = ReturnType<typeof catalogLoras>
interface Inventory {
  files: LoraArtifact[]
  selections: Record<string, { id: string; target: string; signature: string }>
}
interface Identity {
  source?: string | undefined
  target?: string | undefined
  signature: string
}
export interface LoraLease {
  file: string
  release: () => void
}
async function validateAdapter(path: string, mode: LoraMode) {
  if (mode === 'chat') {
    const { metadata } = await readGgufMetadataFromFile(path)
    if (metadata['adapter.type'] === 'lora' && metadata['general.type'] === 'adapter') return
  } else {
    const handle = await open(path, 'r')
    try {
      const prefix = Buffer.alloc(8)
      if ((await handle.read(prefix)).bytesRead === 8) {
        const length = Number(prefix.readBigUInt64LE())
        if (length > 0 && length <= 8 * 1024 * 1024) {
          const bytes = Buffer.alloc(length)
          if (
            (await handle.read(bytes)).bytesRead === length &&
            hasLoraTensors(JSON.parse(bytes.toString('utf8')))
          )
            return
        }
      }
    } finally {
      await handle.close()
    }
  }
  throw new AtomicCoreError('MODEL_FILE_CORRUPT', 'The file does not contain supported LoRA adapter weights.')
}

export class LoraService {
  private entries = new Map<string, LoraArtifact>()
  private bundled = new Map<
    string,
    { published: Awaited<ReturnType<typeof bundledLoras>>; expires: number }
  >()
  private transfers = new Map<string, Promise<void>>()
  private verified = new Map<string, string>()
  private refreshAt = 0
  constructor(
    private root: string,
    private downloader: Downloader,
    private request: typeof fetch,
    private catalog: Catalog,
    private chatIdentity: (
      model: string,
      previous?: { target: string; signature: string }
    ) => Promise<Identity>,
    private restart: (model: string, rollback: () => Promise<void>) => Promise<unknown>,
    private refresh: () => Promise<Catalog>,
    private mediaIdentity: (mode: LoraMode, model: string) => Promise<string | undefined>,
    private mutations = new FifoLock()
  ) {
    this.remember(catalog.files)
  }
  private remember(files: LoraArtifact[]) {
    for (const row of files) if (!this.entries.has(row.sha256)) this.entries.set(row.sha256, row)
  }
  private get index() {
    return join(this.root, 'loras', 'index.json')
  }
  private async state(): Promise<Inventory> {
    return (await optionalJson<Inventory>(this.index)) ?? { files: [], selections: {} }
  }
  private path(row: LoraArtifact) {
    if (!fileId(row.sha256)) throw new AtomicCoreError('INVALID_ARGUMENT', 'Invalid LoRA file ID.')
    return row.mode === 'chat'
      ? join('loras', 'chat', row.sha256 + '.gguf')
      : join('diffusion', 'loras', row.sha256 + '.safetensors')
  }
  async list() {
    return {
      files: (await this.state()).files,
      downloads: this.downloader.snapshot().filter((d) => d.taskId.startsWith('lora:')),
    }
  }
  async search(q: string, target?: string, live = false, source?: string, repoOnly = false) {
    let partial = false
    const repo = source ?? target
    const repoKey = repo?.toLowerCase()
    let snapshot = repoKey ? this.bundled.get(repoKey) : undefined
    if (live && repo && repoKey && (!snapshot || snapshot.expires <= Date.now())) {
      try {
        const published = await bundledLoras(this.request, repo)
        snapshot = { published, expires: Date.now() + (published.partial ? 0 : 300_000) }
        if (this.bundled.size >= 256) this.bundled.delete(this.bundled.keys().next().value!)
        this.bundled.set(repoKey, snapshot)
        this.remember(published.results)
        if (published.origin) this.catalog.sources.set(repoKey, published.origin)
      } catch {
        partial = true
      }
    }
    partial ||= snapshot?.published.partial ?? false
    if (live && !repoOnly && Date.now() >= this.refreshAt) {
      this.refreshAt = Date.now() + 3600000
      try {
        const update = await this.refresh()
        this.remember(update.files)
        for (const [k, v] of update.sources) this.catalog.sources.set(k, v)
        for (const [k, v] of update.familyRepos) this.catalog.familyRepos.set(k, v)
        for (const [k, v] of update.families) this.catalog.families.set(k, v)
      } catch {
        this.refreshAt = Date.now() + 60000
        partial = true
      }
    }
    if (!target && source) target = this.catalog.sources.get(source.toLowerCase()) ?? source
    if (live && !repoOnly) {
      try {
        const found = await discoverLoras(
          this.request,
          q,
          target,
          snapshot?.published.results.length && !snapshot.published.partial ? repo : undefined
        )
        this.remember(found.results)
        partial ||= found.partial
      } catch {
        partial = true
      }
    }
    this.remember((await this.state()).files)
    const words = q.toLowerCase().trim().split(/\s+/)
    const bundled = snapshot?.published.results ?? []
    const matchesQuery = (row: LoraArtifact) =>
      words.every((w) => [row.repo, row.file, row.target, row.mode].join(' ').toLowerCase().includes(w))
    const rows = [
      ...bundled.filter(
        (r) => !target || target.toLowerCase() === repoKey || r.target.toLowerCase() === target.toLowerCase()
      ),
      ...[...this.entries.values()]
        .filter((row) => !target || target.toLowerCase() === row.target.toLowerCase())
        .sort((a, b) => Number(b.repo.toLowerCase() === repoKey) - Number(a.repo.toLowerCase() === repoKey)),
    ]
    const unique = new Map<string, LoraArtifact>()
    for (const row of rows) if (matchesQuery(row) && !unique.has(row.sha256)) unique.set(row.sha256, row)
    return { partial, target, results: [...unique.values()] }
  }
  install(id: string) {
    const existing = this.transfers.get(id)
    if (existing) return existing
    const row = this.entries.get(id)
    if (!row) throw new AtomicCoreError('INVALID_ARGUMENT', 'Refresh the adapter list before installing.')
    const task = this.download(row).finally(() => this.transfers.delete(id))
    this.transfers.set(id, task)
    return task
  }
  private async download(row: LoraArtifact) {
    const relative = this.path(row)
    await this.downloader.download(
      'lora:' + row.sha256,
      [
        {
          url: hfResolveUrl(row.repo, row.file, row.revision),
          save_path: relative,
          size: row.size,
          sha256: row.sha256,
          model_id: 'lora:' + row.sha256,
        },
      ],
      { resume: true }
    )
    const path = join(this.root, relative)
    await this.verify(row)
    await validateAdapter(path, row.mode)
    await this.mutations.run(async () => {
      const state = await this.state()
      state.files = state.files.filter((r) => r.sha256 !== row.sha256).concat(row)
      await save(this.index, state)
    })
  }
  cancel(id: string) {
    return this.downloader.cancel('lora:' + id)
  }
  private async identity(
    mode: LoraMode,
    model: string,
    previous?: Inventory['selections'][string]
  ): Promise<Identity> {
    if (
      !model ||
      model.split('/').some((p) => !p || p === '.' || p === '..' || /[\\\0]/.test(p)) ||
      (mode === 'chat' && model.includes(':'))
    )
      throw new AtomicCoreError('INVALID_ARGUMENT', 'Invalid model ID.')
    if (mode === 'chat') return this.chatIdentity(model, previous)
    if (previous?.signature === model) return previous
    const family = model.split(':')[0]
    const target = this.catalog.families.get(mode + ':' + family) ?? (await this.mediaIdentity(mode, model))
    return { target, source: this.catalog.familyRepos.get(mode + ':' + family), signature: model }
  }
  async choices(mode: LoraMode, model: string) {
    const state = await this.state()
    const binding = state.selections[mode + ':' + model]
    const { target, source, signature } = await this.identity(mode, model)
    const files = state.files.filter(
      (row) => row.mode === mode && row.target.toLowerCase() === target?.toLowerCase()
    )
    return {
      target,
      ...(source ? { source } : {}),
      adapterId:
        binding?.signature === signature && files.some((r) => r.sha256 === binding.id) ? binding.id : null,
      files,
    }
  }
  private async verify(row: LoraArtifact) {
    const path = join(this.root, this.path(row))
    const info = await stat(path)
    const signature = [info.size, info.mtimeMs, info.ctimeMs].join(':')
    if (this.verified.get(row.sha256) !== signature) {
      if (info.size !== row.size || (await sha256File(path)) !== row.sha256)
        throw new AtomicCoreError('MODEL_FILE_CORRUPT', 'Selected LoRA is incomplete or corrupt.')
      this.verified.set(row.sha256, signature)
    }
    return path
  }
  async resolve(mode: LoraMode, model: string) {
    const state = await this.state()
    const binding = state.selections[mode + ':' + model]
    if (!binding) return
    const ctx = await this.identity(mode, model, binding)
    if (ctx.signature !== binding.signature) return
    const row = state.files.find(
      (r) =>
        r.sha256 === binding.id && r.mode === mode && r.target.toLowerCase() === ctx.target?.toLowerCase()
    )
    if (!row)
      throw new AtomicCoreError('MODEL_INCOMPATIBLE', 'The selected adapter no longer matches this model.')
    return this.verify(row)
  }
  async acquire(mode: 'image' | 'video', model: string): Promise<LoraLease | undefined> {
    return this.mutations.run(async () => {
      const path = await this.resolve(mode, model)
      if (!path) return
      const lease = Symbol()
      const file = basename(path)
      this.leases.set(lease, file)
      return {
        file,
        release: () => {
          this.leases.delete(lease)
        },
      }
    })
  }
  private leases = new Map<symbol, string>()
  select(mode: LoraMode, model: string, id: string | null) {
    return this.mutations.run(async () => {
      const state = await this.state()
      const key = mode + ':' + model
      const ctx = await this.identity(mode, model, state.selections[key])
      if (id !== null) {
        const row = state.files.find(
          (r) => r.sha256 === id && r.mode === mode && r.target.toLowerCase() === ctx.target?.toLowerCase()
        )
        if (!row)
          throw new AtomicCoreError('INVALID_ARGUMENT', 'Choose an installed adapter for this checkpoint.')
        await this.verify(row)
      }
      await this.change(state, key, id ? { id, signature: ctx.signature, target: ctx.target! } : undefined)
    })
  }
  private async change(state: Inventory, key: string, next: Inventory['selections'][string] | undefined) {
    const old = state.selections[key]
    if (old?.id === next?.id && old?.signature === next?.signature) return
    const set = async (value: typeof next) => {
      if (value) state.selections[key] = value
      else delete state.selections[key]
      await save(this.index, state)
    }
    await set(next)
    if (key.startsWith('chat:')) {
      try {
        await this.restart(key.slice(5), () => set(old))
      } catch (error) {
        await set(old)
        throw error
      }
    }
  }
  remove(id: string) {
    return this.mutations.run(async () => {
      const state = await this.state()
      const row = state.files.find((r) => r.sha256 === id)
      if (!row) return
      if (this.transfers.has(id) || [...this.leases.values()].includes(basename(this.path(row))))
        throw new AtomicCoreError('JOB_BUSY', 'This LoRA is in use.')
      for (const [key, binding] of Object.entries(state.selections))
        if (binding.id === id) await this.change(state, key, undefined)
      state.files = state.files.filter((r) => r.sha256 !== id)
      await save(this.index, state)
      await rm(join(this.root, this.path(row)), { force: true })
    })
  }
}
