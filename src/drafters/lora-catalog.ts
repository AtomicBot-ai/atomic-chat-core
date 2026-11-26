import { hfResolveUrl, readGgufMetadataChunked } from '../models/index.js'
import type { AtomicModelCatalog } from '../client/index.js'
import { catalogCheckpointSources, fileId, quantizedFrom, repoId } from './catalog.js'

export type LoraMode = 'chat' | 'image' | 'video'
export function isLoraMode(value: unknown): value is LoraMode {
  return value === 'chat' || value === 'image' || value === 'video'
}
export interface LoraArtifact {
  sha256: string
  repo: string
  revision: string
  target: string
  mode: LoraMode
  file: string
  size: number
}
function valid(row: LoraArtifact) {
  return (
    repoId(row.repo) &&
    repoId(row.target) &&
    /^[a-f0-9]{40}$/.test(row.revision) &&
    fileId(row.sha256) &&
    Number.isSafeInteger(row.size) &&
    row.size > 0 &&
    row.file.split('/').every((part) => part !== '.' && part !== '..' && /^[\w+. -]+$/.test(part)) &&
    row.file.toLowerCase().endsWith(row.mode === 'chat' ? '.gguf' : '.safetensors')
  )
}
export function catalogLoras(catalog: Pick<AtomicModelCatalog, 'models'>) {
  const files: LoraArtifact[] = []
  const families = new Map<string, string>()
  for (const entry of Object.values(catalog.models)) {
    const { method, modality, repo, revision, target, target_family } = entry.definition
    if (
      entry.kind !== 'auxiliary' ||
      method !== 'lora' ||
      !isLoraMode(modality) ||
      entry.format !== (modality === 'chat' ? 'gguf' : 'safetensors') ||
      !repoId(repo) ||
      !repoId(target) ||
      typeof revision !== 'string'
    )
      continue
    for (const f of entry.files ?? []) {
      const row = {
        mode: modality,
        repo,
        revision,
        target,
        sha256: f.sha256 ?? '',
        size: f.size,
        file: f.path,
      }
      if (valid(row)) {
        files.push(row)
        if (typeof target_family === 'string') families.set(modality + ':' + target_family, target)
      }
    }
  }
  const sources = catalogCheckpointSources(catalog)
  const familyRepos = new Map<string, string>()
  for (const [key, entry] of Object.entries(catalog.models)) {
    if (entry.kind !== 'diffusion' || !key.startsWith('diffusion:')) continue
    const repo = (entry.definition.transformer as { repo?: unknown } | undefined)?.repo
    if (repoId(repo)) {
      const family = entry.definition.modality + ':' + key.slice('diffusion:'.length)
      familyRepos.set(family, repo)
      const target = families.get(family)
      if (target) sources.set(repo.toLowerCase(), target)
    }
  }
  return { files, families, sources, familyRepos }
}
interface Publication {
  id: string
  sha: string
  pipeline_tag?: string
  tags?: string[]
  cardData?: { base_model?: string | string[] }
  siblings?: { rfilename: string; lfs?: { size: number; sha256: string } }[]
}
const maxHeader = 8 * 1024 * 1024
export function hasLoraTensors(header: unknown) {
  return (
    !!header &&
    typeof header === 'object' &&
    Object.keys(header).some(
      (name) =>
        // These unconverted PEFT names leave tensors unmatched in sd-server, even when generation succeeds.
        !name.startsWith('base_model.model.') &&
        !/\.lora_[AB]\.default\.weight$/i.test(name) &&
        /(?:^|[._])lora[._](?:up|down|a|b)(?:[._]|$)/i.test(name)
    )
  )
}
async function adapterMetadata(
  request: typeof fetch,
  row: Omit<LoraArtifact, 'target'>
): Promise<{ base?: string } | undefined> {
  const url = hfResolveUrl(row.repo, row.file, row.revision)
  const signal = AbortSignal.timeout(10000)
  const prefix = async (want: number) => {
    const size = Math.min(want, row.size)
    const response = await request(url, { headers: { Range: 'bytes=0-' + (size - 1) }, signal })
    const reader = response.body?.getReader()
    if (!response.ok || !reader) {
      await reader?.cancel()
      throw new Error('Adapter header unavailable')
    }
    const bytes = Buffer.alloc(size)
    let offset = 0
    try {
      while (offset < size) {
        const { value, done } = await reader.read()
        if (done) break
        const count = Math.min(value.length, size - offset)
        bytes.set(value.subarray(0, count), offset)
        offset += count
      }
    } finally {
      await reader.cancel()
    }
    return bytes.subarray(0, offset)
  }
  if (row.mode === 'chat') {
    const { metadata } = await readGgufMetadataChunked(prefix, { chunkSize: 65536, maxBytes: maxHeader })
    if (metadata['general.type'] !== 'adapter' || metadata['adapter.type'] !== 'lora') return
    const base = metadata['general.base_model.0.repo_url']
      ?.replace(/^https:\/\/huggingface\.co\//, '')
      .replace(/\/$/, '')
    return repoId(base) ? { base } : {}
  }
  const first = await prefix(16384)
  if (first.length < 8) return
  const size = Number(first.readBigUInt64LE())
  if (size < 2 || size > maxHeader || size + 8 > row.size) return
  const data = first.length >= size + 8 ? first : await prefix(size + 8)
  return hasLoraTensors(JSON.parse(data.toString('utf8', 8, size + 8))) ? {} : undefined
}
async function publicationJson<T>(request: typeof fetch, url: string): Promise<T> {
  const response = await request(url, { signal: AbortSignal.timeout(12000) })
  if (!response.ok) throw new Error('Hugging Face returned ' + response.status)
  return (await response.json()) as T
}

async function publicationLoras(
  request: typeof fetch,
  publication: Publication,
  target?: string,
  bundled = false
) {
  const results: LoraArtifact[] = []
  let partial = false
  const base = publication.cardData?.base_model
  const checkpoint = Array.isArray(base) && base.length === 1 ? base[0] : base
  if (!repoId(publication.id) || !/^[a-f0-9]{40}$/.test(publication.sha)) return { results, partial }
  if (!bundled && (!repoId(checkpoint) || (target && checkpoint.toLowerCase() !== target.toLowerCase())))
    return { results, partial }
  const tags = [publication.pipeline_tag, ...(publication.tags ?? [])]
  const mode = tags.some((t) => t === 'text-to-video' || t === 'image-to-video')
    ? 'video'
    : tags.some((t) => t === 'text-to-image' || t === 'image-to-image')
      ? 'image'
      : 'chat'
  for (const file of publication.siblings ?? []) {
    if (!file.lfs) continue
    const path = file.rfilename
    const config = path.replace(/[^/]+$/, 'adapter_config.json')
    const hasConfig = bundled && publication.siblings?.some((s) => s.rfilename === config)
    if (bundled && !hasConfig && !/lora|adapter/i.test(path)) continue
    const row = { mode, repo: publication.id, revision: publication.sha, file: path, ...file.lfs } as const
    // Validate paths and digests before constructing a resolve URL.
    if (!valid({ ...row, target: publication.id })) continue
    try {
      const metadata = await adapterMetadata(request, row)
      if (!metadata) continue
      const configBase =
        hasConfig && !metadata.base
          ? (
              await publicationJson<{ base_model_name_or_path?: string }>(
                request,
                hfResolveUrl(row.repo, config, row.revision)
              )
            ).base_model_name_or_path
          : undefined
      const base = metadata.base ?? configBase ?? checkpoint
      if (repoId(base) && (!target || target.toLowerCase() === base.toLowerCase()))
        results.push({ ...row, target: base })
    } catch {
      partial = true
    }
  }
  return { results, partial }
}

/** The blobs and commit in a single HF response identify immutable files. */
export async function bundledLoras(request: typeof fetch, source: string) {
  const publication = await publicationJson<Publication>(
    request,
    'https://huggingface.co/api/models/' + source + '?blobs=true'
  )
  const origin = quantizedFrom(publication.tags)
  if (publication.id?.toLowerCase() !== source.toLowerCase()) return { origin, results: [], partial: true }
  return { origin, ...(await publicationLoras(request, publication, undefined, true)) }
}

export async function discoverLoras(
  request: typeof fetch,
  query: string,
  target?: string,
  skipRepo?: string
) {
  const params = new URLSearchParams({ limit: '24', full: 'true', cardData: 'true' })
  if (query.trim()) params.set('search', query.trim())
  if (target) params.set('filter', 'base_model:adapter:' + target)
  else if (!query.trim()) params.set('filter', 'lora')
  const repos = await publicationJson<Publication[]>(request, 'https://huggingface.co/api/models?' + params)
  const results: LoraArtifact[] = []
  let partial = false
  for (let offset = 0; offset < repos.length; offset += 6) {
    await Promise.all(
      repos.slice(offset, offset + 6).map(async (item) => {
        if (
          !repoId(item.id) ||
          !/^[a-f0-9]{40}$/.test(item.sha) ||
          item.id.toLowerCase() === skipRepo?.toLowerCase()
        )
          return
        try {
          const publication = await publicationJson<Publication>(
            request,
            'https://huggingface.co/api/models/' + item.id + '/revision/' + item.sha + '?blobs=true'
          )
          const found = await publicationLoras(
            request,
            { ...publication, id: item.id, sha: item.sha },
            target
          )
          results.push(...found.results)
          partial ||= found.partial
        } catch {
          partial = true
        }
      })
    )
  }
  return { results, partial }
}
