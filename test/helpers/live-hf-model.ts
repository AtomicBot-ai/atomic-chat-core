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

/** How many times one request or one file is tried before the run gives up on it. */
const ATTEMPTS = 6
const MAX_WAIT_MS = 10 * 60_000

/** A failure that says whether trying again can help, and how long the server asked us to wait. */
class DownloadFailure extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null
  ) {
    super(message)
  }
}

/** `Retry-After` in ms, as delay-seconds or an HTTP date; null when absent or unreadable. Capped. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (header === null || header.trim() === '') return null
  const seconds = Number(header.trim())
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now
  return Number.isFinite(ms) ? Math.min(MAX_WAIT_MS, Math.max(0, ms)) : null
}

/** Rate limits, timeouts and server errors pass; a 401/403/404 will answer the same next time. */
const retryableStatus = (status: number): boolean => status === 408 || status === 429 || status >= 500

/**
 * Runs `attempt` up to `ATTEMPTS` times. Network errors, a dropped body (undici's body timeout on a
 * multi-gigabyte shard), a 408/429/5xx and a size or digest mismatch are retried after the server's
 * `Retry-After`, or 2 s doubling to 60 s; anything a retry cannot fix is thrown at once.
 */
async function withRetry<T>(
  what: string,
  log: (line: string) => void,
  attempt: () => Promise<T>
): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await attempt()
    } catch (error) {
      const failure = error instanceof DownloadFailure ? error : null
      if ((failure !== null && !failure.retryable) || n >= ATTEMPTS) throw error
      const wait = failure?.retryAfterMs ?? Math.min(60_000, 2000 * 2 ** (n - 1))
      const message = (error as Error).message
      const said = message.startsWith(`${what}:`) ? message : `${what}: ${message}`
      log(`  ${said}; retry ${n} of ${ATTEMPTS - 1} in ${(wait / 1000).toFixed(0)} s`)
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }
}

/** One GET; a non-2xx answer becomes a `DownloadFailure` carrying its retry verdict. */
async function get(url: string, headers: Record<string, string> = {}): Promise<Response> {
  const res = await fetch(url, { headers: { ...authHeaders(), ...headers } })
  if (res.ok) return res
  await res.body?.cancel().catch(() => undefined)
  throw new DownloadFailure(
    `Hugging Face answered ${res.status} for ${url}`,
    retryableStatus(res.status),
    retryAfterMs(res.headers.get('retry-after'))
  )
}

const quiet = (): void => undefined

/** Every file of `repository` at exactly `revision`, sizes and LFS digests as Hugging Face lists them. */
export async function listRevision(
  repository: string,
  revision: string,
  log: (line: string) => void = quiet
): Promise<RepoFile[]> {
  const url = `${endpoint()}/api/models/${repository}/revision/${encodeURIComponent(revision)}?blobs=true&files_metadata=true`
  const body = await withRetry(
    `listing ${repository}`,
    log,
    async () => (await (await get(url)).json()) as { sha?: string; siblings?: Sibling[] }
  )
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
  path: string,
  log: (line: string) => void = quiet
): Promise<Record<string, unknown>> {
  return withRetry(
    path,
    log,
    async () => (await (await get(resolveUrl(repository, revision, path))).json()) as Record<string, unknown>
  )
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
 * One attempt at one file. A `.part` left by an earlier attempt is hashed and continued with a
 * `Range` request; a server that ignores the range (200) or refuses it (416) starts it over. Only a
 * file of the listed size and LFS digest is renamed into place; a mismatch discards the `.part`.
 */
async function downloadOnce(
  url: string,
  file: RepoFile,
  target: string,
  log: (line: string) => void
): Promise<void> {
  const part = `${target}.part`
  const hash = createHash('sha256')
  let offset = existsSync(part) ? (await stat(part)).size : 0
  if (offset > file.size) {
    await rm(part, { force: true })
    offset = 0
  }
  if (offset > 0) for await (const chunk of createReadStream(part)) hash.update(chunk as Buffer)
  let bytes = offset
  if (offset < file.size || file.size === 0) {
    let res: Response
    try {
      res = await get(url, offset > 0 ? { range: `bytes=${offset}-` } : {})
    } catch (error) {
      if (error instanceof DownloadFailure && /answered 416/.test(error.message)) {
        await rm(part, { force: true })
        throw new DownloadFailure(`${file.path}: the server refused to resume; starting over`, true)
      }
      throw error
    }
    if (res.body === null) throw new DownloadFailure(`${file.path}: empty response`, true)
    const append = offset > 0 && res.status === 206
    // No `.part`, or the server sent the whole file (200) instead of the range: overwrite from zero
    // with a fresh hash, forgetting what the old `.part` held.
    if (!append) return downloadFresh(res, file, part, target, log)
    log(`  ${file.path}: resuming at ${offset} of ${file.size} bytes`)
    bytes = await streamInto(res, file, part, hash, bytes, 'a', log)
  }
  await finish(file, part, target, hash, bytes)
}

async function downloadFresh(
  res: Response,
  file: RepoFile,
  part: string,
  target: string,
  log: (line: string) => void
): Promise<void> {
  const hash = createHash('sha256')
  const bytes = await streamInto(res, file, part, hash, 0, 'w', log)
  await finish(file, part, target, hash, bytes)
}

/** Streams the body into `part` (append or overwrite), hashing and counting; answers the total size. */
async function streamInto(
  res: Response,
  file: RepoFile,
  part: string,
  hash: ReturnType<typeof createHash>,
  start: number,
  flags: 'a' | 'w',
  log: (line: string) => void
): Promise<number> {
  let bytes = start
  let nextReport = (Math.floor(start / 1024 ** 3) + 1) * 1024 ** 3
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk)
      bytes += chunk.length
      if (bytes >= nextReport) {
        log(`  ${file.path}: ${(bytes / 1024 ** 3).toFixed(1)} of ${(file.size / 1024 ** 3).toFixed(1)} GiB`)
        nextReport += 1024 ** 3
      }
      done(null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(res.body as WebReadableStream), meter, createWriteStream(part, { flags }))
  } catch (error) {
    // The `.part` stays: the next attempt resumes from what reached the disk.
    throw new DownloadFailure(
      `${file.path}: the transfer broke at ${bytes} bytes (${(error as Error).message})`,
      true
    )
  }
  return bytes
}

async function finish(
  file: RepoFile,
  part: string,
  target: string,
  hash: ReturnType<typeof createHash>,
  bytes: number
): Promise<void> {
  if (bytes !== file.size) {
    await rm(part, { force: true })
    throw new DownloadFailure(`${file.path}: got ${bytes} bytes, the listing says ${file.size}`, true)
  }
  const digest = hash.digest('hex')
  if (file.sha256 !== null && digest !== file.sha256) {
    await rm(part, { force: true })
    throw new DownloadFailure(`${file.path}: sha256 ${digest}, the listing says ${file.sha256}`, true)
  }
  await rename(part, target)
}

/**
 * Downloads every file of the revision into `cacheDir` (kept across runs), each through a `.part`
 * name, resumed and retried as `withRetry` says, and renamed only once its size and LFS digest check
 * out.
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
    const started = Date.now()
    const url = resolveUrl(repository, revision, file.path)
    await withRetry(file.path, log, () => downloadOnce(url, file, target, log))
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
 * one `override` names; null when nothing fits, and a throw when `override` is not curated.
 */
export function pickCuratedModel(
  curated: readonly CuratedModel[],
  gpu: { total_bytes: number; compute_capability: string },
  override?: string
): CuratedModel | null {
  if (override !== undefined && override !== '') {
    const named = curated.find((m) => m.repository === override)
    if (named === undefined)
      throw new Error(
        `ATOMIC_LIVE_TRT_MODEL=${override} is not in the descriptor's curated_models ` +
          `(${curated.map((m) => m.repository).join(', ')}); only curated models have a pinned revision and inventory digest`
      )
    return named
  }
  const cc = Number.parseFloat(gpu.compute_capability)
  const needs = (m: CuratedModel): number =>
    /nvfp4/i.test(m.repository) ? 10 : /fp8/i.test(m.repository) ? 8.9 : 8
  return (
    [...curated]
      .filter((m) => m.vram_tier_bytes <= gpu.total_bytes && needs(m) <= cc)
      .sort((a, b) => a.vram_tier_bytes - b.vram_tier_bytes)[0] ?? null
  )
}
