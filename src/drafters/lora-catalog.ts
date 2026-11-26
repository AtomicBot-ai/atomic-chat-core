import { hfResolveUrl, readGgufMetadataChunked } from '../models/index.js'
import type { AtomicModelCatalog } from '../client/index.js'
import { fileId, repoId } from './catalog.js'

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
  return { files, families }
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
        // sd-server accepts the converted FLUX block names. PEFT's base_model wrapper
        // leaves these weights unmatched even though generation itself succeeds.
        !/^base_model\.model\.(?:double|single)_blocks\./.test(name) &&
        /(?:^|[._])lora[._](?:up|down|a|b)(?:[._]|$)/i.test(name)
    )
  )
}
async function hasRemoteWeights(request: typeof fetch, row: LoraArtifact) {
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
    const { metadata } = await readGgufMetadataChunked(prefix, { maxBytes: maxHeader })
    return metadata['general.type'] === 'adapter' && metadata['adapter.type'] === 'lora'
  }
  const first = await prefix(16384)
  if (first.length < 8) return false
  const size = Number(first.readBigUInt64LE())
  if (size < 2 || size > maxHeader || size + 8 > row.size) return false
  const data = first.length >= size + 8 ? first : await prefix(size + 8)
  return hasLoraTensors(JSON.parse(data.toString('utf8', 8, size + 8)))
}
export async function discoverLoras(request: typeof fetch, query: string, target?: string) {
  const params = new URLSearchParams({ filter: 'lora', limit: '24', full: 'true', cardData: 'true' })
  if (query.trim()) params.set('search', query.trim())
  if (target) params.append('filter', 'base_model:adapter:' + target)
  const get = async (url: string) => {
    const response = await request(url, { signal: AbortSignal.timeout(12000) })
    if (!response.ok) throw new Error('Hugging Face returned ' + response.status)
    return response.json()
  }
  const repos = (await get('https://huggingface.co/api/models?' + params)) as Publication[]
  const results: LoraArtifact[] = []
  let partial = false
  for (let offset = 0; offset < repos.length; offset += 6) {
    await Promise.all(
      repos.slice(offset, offset + 6).map(async (item) => {
        if (!repoId(item.id) || !/^[a-f0-9]{40}$/.test(item.sha)) return
        try {
          const publication = (await get(
            'https://huggingface.co/api/models/' + item.id + '/revision/' + item.sha + '?blobs=true'
          )) as Publication
          const base = publication.cardData?.base_model
          const checkpoint = Array.isArray(base) && base.length === 1 ? base[0] : base
          if (!repoId(checkpoint) || (target && checkpoint.toLowerCase() !== target.toLowerCase())) return
          const tags = [publication.pipeline_tag, ...(publication.tags ?? [])]
          for (const file of publication.siblings ?? []) {
            const mode = tags.some((t) => t === 'text-to-video' || t === 'image-to-video')
              ? 'video'
              : tags.some((t) => t === 'text-to-image' || t === 'image-to-image')
                ? 'image'
                : 'chat'
            if (!file.lfs) continue
            const row = {
              mode,
              repo: item.id,
              revision: item.sha,
              target: checkpoint,
              file: file.rfilename,
              ...file.lfs,
            } satisfies LoraArtifact
            if (!valid(row)) continue
            try {
              if (await hasRemoteWeights(request, row)) results.push(row)
            } catch {
              partial = true
            }
          }
        } catch {
          partial = true
        }
      })
    )
  }
  return { results, partial }
}
