/**
 * The model half of the managed-install live test (task 2.18): the core never downloads a model
 * (design D12), so the test does what the app and the CLI do for a curated `tensorrt-llm` model —
 *
 *   1. list the repository at exactly the curated revision (`/api/models/<repo>/revision/<rev>?
 *      blobs=true&files_metadata=true`, the endpoint conf's `inventory-digest.mjs` uses) and refuse
 *      it unless the listing's `inventory_digest` equals the descriptor's;
 *   2. fetch `config.json` (and `hf_quant_config.json` when listed) and ask the core
 *      `POST /models/tensorrt-llm/check` whether it would run here, when this build has that route;
 *   3. download every file of the revision into a persistent cache, checking each size and each
 *      LFS sha256;
 *   4. hard-link the files into `<data>/tensorrt-llm/models/<id>/` and write `model.yml` last.
 *
 * Only the curated list is used, and curated models are ungated: no token is needed. `HF_ENDPOINT`
 * (the Hugging Face tooling's own variable) points it at a mirror; `HF_TOKEN` is sent when set.
 *
 * No imports from `src/`. `inventoryDigest` restates conf's reference algorithm on purpose: the live
 * run then checks the published digest independently of the core's copy.
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { copyFile, link, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { stringify } from 'yaml'

export interface CuratedModel {
  repository: string
  revision: string
  inventory_digest: string
  vram_tier_bytes: number
  note: string
}

export interface RepoFile {
  path: string
  size: number
  /** The LFS sha256 Hugging Face publishes; null for a small git-stored file. */
  sha256: string | null
}

const endpoint = (): string => (process.env['HF_ENDPOINT'] ?? 'https://huggingface.co').replace(/\/+$/, '')
const authHeaders = (): Record<string, string> =>
  process.env['HF_TOKEN'] ? { authorization: `Bearer ${process.env['HF_TOKEN']}` } : {}

const NUL = String.fromCharCode(0)

/** conf `.github/scripts/inventory-digest.mjs`, restated: path-sorted, length-prefixed, NUL-separated. */
export function inventoryDigest(files: readonly RepoFile[]): string {
  const hash = createHash('sha256')
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (const file of sorted) {
    hash.update(`${file.path.length}:${file.path}`)
    hash.update(`|${file.size}|`)
    hash.update(file.sha256 ?? '')
    hash.update(NUL)
  }
  return `sha256:${hash.digest('hex')}`
}

interface Sibling {
  rfilename: string
  size?: number
  lfs?: { sha256?: string; size?: number }
}

/** Every file of `repository` at exactly `revision`, sizes and LFS digests as Hugging Face lists them. */
export async function listRevision(repository: string, revision: string): Promise<RepoFile[]> {
  const url = `${endpoint()}/api/models/${repository}/revision/${encodeURIComponent(revision)}?blobs=true&files_metadata=true`
  const res = await fetch(url, { headers: authHeaders() })
  if (!res.ok) throw new Error(`Hugging Face answered ${res.status} for ${url}`)
  const body = (await res.json()) as { sha?: string; siblings?: Sibling[] }
  if (body.sha !== revision) throw new Error(`asked for ${revision}, Hugging Face answered with ${body.sha}`)
  if (!Array.isArray(body.siblings) || body.siblings.length === 0) throw new Error(`${url} lists no files`)
  return body.siblings.map((s) => ({
    path: s.rfilename,
    size: s.lfs?.size ?? s.size ?? 0,
    sha256: typeof s.lfs?.sha256 === 'string' && s.lfs.sha256 !== '' ? s.lfs.sha256 : null,
  }))
}

const resolveUrl = (repository: string, revision: string, path: string): string =>
  `${endpoint()}/${repository}/resolve/${revision}/${path.split('/').map(encodeURIComponent).join('/')}`

/** A small JSON file of the revision (`config.json`, `hf_quant_config.json`). */
export async function fetchJson(
  repository: string,
  revision: string,
  path: string
): Promise<Record<string, unknown>> {
  const res = await fetch(resolveUrl(repository, revision, path), { headers: authHeaders() })
  if (!res.ok) throw new Error(`Hugging Face answered ${res.status} for ${path}`)
  return (await res.json()) as Record<string, unknown>
}

/** sha256 of a file on disk, streamed. */
async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

/** A file already in the cache counts only at its listed size and, for LFS, its listed sha256. */
async function cachedIntact(path: string, file: RepoFile): Promise<boolean> {
  if (!existsSync(path)) return false
  if ((await stat(path)).size !== file.size) return false
  return file.sha256 === null || (await sha256Of(path)) === file.sha256
}

/**
 * Downloads every file of the revision into `cacheDir` (kept across runs), each through a `.part`
 * name and renamed only once its size and LFS digest check out.
 */
export async function downloadRevision(
  repository: string,
  revision: string,
  files: readonly RepoFile[],
  cacheDir: string,
  log: (line: string) => void
): Promise<void> {
  for (const file of files) {
    const target = join(cacheDir, ...file.path.split('/'))
    if (await cachedIntact(target, file)) continue
    await mkdir(dirname(target), { recursive: true })
    const part = `${target}.part`
    const started = Date.now()
    const res = await fetch(resolveUrl(repository, revision, file.path), { headers: authHeaders() })
    if (!res.ok || res.body === null) throw new Error(`Hugging Face answered ${res.status} for ${file.path}`)
    const hash = createHash('sha256')
    let bytes = 0
    let nextReport = 1024 ** 3
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        hash.update(chunk)
        bytes += chunk.length
        if (bytes >= nextReport) {
          log(
            `  ${file.path}: ${(bytes / 1024 ** 3).toFixed(1)} of ${(file.size / 1024 ** 3).toFixed(1)} GiB`
          )
          nextReport += 1024 ** 3
        }
        done(null, chunk)
      },
    })
    await pipeline(Readable.fromWeb(res.body as WebReadableStream), meter, createWriteStream(part))
    if (bytes !== file.size)
      throw new Error(`${file.path}: downloaded ${bytes} bytes, the listing says ${file.size}`)
    const digest = hash.digest('hex')
    if (file.sha256 !== null && digest !== file.sha256)
      throw new Error(`${file.path}: sha256 ${digest}, the listing says ${file.sha256}`)
    await rename(part, target)
    log(`  downloaded ${file.path} (${file.size} bytes) in ${((Date.now() - started) / 1000).toFixed(1)} s`)
  }
}

/**
 * The quantization name `model.yml` records, when the core's check route is not there to say it:
 * ModelOpt's `hf_quant_config.json` `quant_algo` (FP8, NVFP4), else the checkpoint's own dtype.
 */
export function quantizationOf(
  config: Record<string, unknown>,
  hfQuant: Record<string, unknown> | null
): string {
  const algo = (hfQuant?.['quantization'] as { quant_algo?: unknown } | undefined)?.quant_algo
  if (typeof algo === 'string' && algo !== '') return algo.toLowerCase()
  const dtype = config['torch_dtype'] ?? config['dtype']
  if (dtype === 'bfloat16') return 'bf16'
  if (dtype === 'float16') return 'fp16'
  return String(dtype ?? 'unknown')
}

/**
 * The model directory the app and the CLI would leave: every file hard-linked from the cache (a copy
 * across file systems), and `model.yml` written last — a directory without it is a download in
 * progress, not a model (spec `tensorrt-llm-models`).
 */
export async function installModel(options: {
  dataFolder: string
  id: string
  cacheDir: string
  repository: string
  revision: string
  files: readonly RepoFile[]
  architectures: string[]
  quantization: string
}): Promise<string> {
  const dir = join(options.dataFolder, 'tensorrt-llm', 'models', ...options.id.split('/'))
  await rm(dir, { recursive: true, force: true })
  for (const file of options.files) {
    const from = join(options.cacheDir, ...file.path.split('/'))
    const to = join(dir, ...file.path.split('/'))
    await mkdir(dirname(to), { recursive: true })
    await link(from, to).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EXDEV' && error.code !== 'EPERM') throw error
      await copyFile(from, to)
    })
  }
  await writeFile(
    join(dir, 'model.yml'),
    stringify({
      name: options.id,
      repository: options.repository,
      revision: options.revision,
      architectures: options.architectures,
      quantization: options.quantization,
      files: options.files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 })),
    })
  )
  return dir
}

/**
 * The curated model for this card: the smallest `vram_tier_bytes` the card holds whose format the
 * card's compute capability runs (NVFP4 needs 10.0, FP8 8.9, BF16 8.0 — the names say which), or the
 * one `override` names.
 */
export function pickCuratedModel(
  curated: readonly CuratedModel[],
  gpu: { total_bytes: number; compute_capability: string },
  override?: string
): CuratedModel | null {
  if (override !== undefined && override !== '') return curated.find((m) => m.repository === override) ?? null
  const cc = Number.parseFloat(gpu.compute_capability)
  const needs = (m: CuratedModel): number =>
    /nvfp4/i.test(m.repository) ? 10 : /fp8/i.test(m.repository) ? 8.9 : 8
  return (
    [...curated]
      .filter((m) => m.vram_tier_bytes <= gpu.total_bytes && needs(m) <= cc)
      .sort((a, b) => a.vram_tier_bytes - b.vram_tier_bytes)[0] ?? null
  )
}
