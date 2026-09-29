/**
 * The engine half of the TensorRT-LLM live test (task 2.19): what a model container and its card show
 * from outside the core — `docker inspect`, `/dev/shm` inside the container, the heartbeat file the
 * core touches, the card's memory — and the timing constants the core was built with, read from
 * `src/` as text so the report can cite them by file and line next to what the run measured.
 *
 * Every Docker call goes through `sudoDocker`/`sudoDockerAsync`, the same root view of the system
 * daemon the install test uses. Nothing here starts, stops or removes a container; `docker exec` is
 * used for one read-only `df` inside the engine container.
 *
 * No imports from `src/`: the live test drives the compiled binary only.
 */
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { gpuMemoryUsed, sudoDocker, sudoDockerAsync } from './live-linux-host.js'

/** Where the core mounts the heartbeat directory inside the container (`CONTAINER_HEARTBEAT_PATH`). */
export const CONTAINER_HEARTBEAT_PATH = '/atomic/heartbeat'
/** Where the core mounts the model's engine cache inside the container (`CONTAINER_ENGINE_CACHE_PATH`). */
export const CONTAINER_ENGINE_CACHE_PATH = '/atomic/engine-cache'
/** The exit code the watchdog script ends with when it stopped the engine over a stale heartbeat. */
export const WATCHDOG_EXIT_STALE_HEARTBEAT = 97

export interface ContainerFacts {
  id: string
  running: boolean
  /** Null while it runs. */
  exit_code: number | null
  started_at: string | null
  finished_at: string | null
  /** `HostConfig.Memory`: 0 means Docker sets no memory limit. */
  memory_limit_bytes: number
  memory_swap_bytes: number
  /** `HostConfig.ShmSize`, the `--shm-size` the container got. */
  shm_size_bytes: number | null
  /** The cards `--gpus device=<uuid>` gave it. */
  gpu_device_ids: string[]
  /** `ATOMIC_WATCHDOG_*` from its environment: the watchdog timing this core build really used. */
  watchdog_env: Record<string, string>
  /** `Config.Cmd`: the engine argv after the watchdog's `--` (parsers, context length, ...). */
  command: string[]
  /** `Config.User` (`uid:gid`); null when the image's default user runs it. */
  user: string | null
  labels: Record<string, string>
  /** The host directory mounted at `/atomic/engine-cache`: the model's engine cache. */
  engine_cache_source: string | null
  /** The host directory mounted at `/atomic/heartbeat`: the core writes `heartbeat` in it. */
  heartbeat_source: string | null
  /** The load generation, read off the heartbeat mount (`.../heartbeats/<generation>`). */
  generation: string | null
}

interface InspectEntry {
  Id?: string
  State?: { Running?: boolean; ExitCode?: number; StartedAt?: string; FinishedAt?: string }
  HostConfig?: {
    Memory?: number
    MemorySwap?: number
    ShmSize?: number
    DeviceRequests?: Array<{ DeviceIDs?: string[] | null }> | null
  }
  Config?: {
    Env?: string[] | null
    Cmd?: string[] | null
    Labels?: Record<string, string> | null
    User?: string
  }
  Mounts?: Array<{ Source?: string; Destination?: string }> | null
}

/**
 * A Docker timestamp in ms since the epoch. Docker prints nanoseconds (`...:05.123456789Z`); only the
 * milliseconds are kept, so the parse does not depend on how many fraction digits a runtime accepts.
 */
export function dockerTimeMs(value: string | null): number | null {
  if (value === null) return null
  const ms = Date.parse(value.replace(/(\.\d{3})\d+/, '$1'))
  return Number.isFinite(ms) ? ms : null
}

/** Docker's zero time, which `FinishedAt` holds for a container that has not exited. */
const dockerTime = (value: string | undefined): string | null =>
  value === undefined || value === '' || value.startsWith('0001-01-01') ? null : value

/** A name the core percent-encoded (`encodeManagedId`), decoded; itself when it is not valid encoding. */
const decodeName = (name: string): string => {
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

/** `docker inspect <id>` (the JSON array it prints) reduced to what the report and the checks need. */
export function containerFacts(inspectJson: string): ContainerFacts | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(inspectJson)
  } catch {
    return null
  }
  const entry = (Array.isArray(parsed) ? parsed[0] : parsed) as InspectEntry | undefined
  if (entry === undefined || entry === null || typeof entry.Id !== 'string') return null
  const running = entry.State?.Running === true
  const env: Record<string, string> = {}
  for (const pair of entry.Config?.Env ?? []) {
    const at = pair.indexOf('=')
    if (at > 0 && pair.startsWith('ATOMIC_WATCHDOG_')) env[pair.slice(0, at)] = pair.slice(at + 1)
  }
  const heartbeat = (entry.Mounts ?? []).find((m) => m.Destination === CONTAINER_HEARTBEAT_PATH)
  const engineCache = (entry.Mounts ?? []).find((m) => m.Destination === CONTAINER_ENGINE_CACHE_PATH)
  return {
    id: entry.Id,
    running,
    exit_code: running || typeof entry.State?.ExitCode !== 'number' ? null : entry.State.ExitCode,
    started_at: dockerTime(entry.State?.StartedAt),
    finished_at: running ? null : dockerTime(entry.State?.FinishedAt),
    memory_limit_bytes: entry.HostConfig?.Memory ?? 0,
    memory_swap_bytes: entry.HostConfig?.MemorySwap ?? 0,
    shm_size_bytes: typeof entry.HostConfig?.ShmSize === 'number' ? entry.HostConfig.ShmSize : null,
    gpu_device_ids: (entry.HostConfig?.DeviceRequests ?? []).flatMap((r) => r.DeviceIDs ?? []),
    watchdog_env: env,
    command: entry.Config?.Cmd ?? [],
    user: entry.Config?.User === undefined || entry.Config.User === '' ? null : entry.Config.User,
    labels: entry.Config?.Labels ?? {},
    engine_cache_source:
      engineCache?.Source === undefined || engineCache.Source === '' ? null : engineCache.Source,
    heartbeat_source: heartbeat?.Source === undefined || heartbeat.Source === '' ? null : heartbeat.Source,
    generation:
      heartbeat?.Source === undefined || heartbeat.Source === ''
        ? null
        : decodeName(basename(heartbeat.Source)),
  }
}

export interface WatchdogTiming {
  stale_limit_secs: number
  poll_interval_secs: number
  kill_grace_secs: number
}

/** The watchdog's timing from a container's `ATOMIC_WATCHDOG_*` env; null when any is missing or not a positive integer. */
export function watchdogTiming(env: Record<string, string>): WatchdogTiming | null {
  const read = (name: string): number | null => {
    const value = env[name]
    return value !== undefined && /^[1-9][0-9]*$/.test(value) ? Number(value) : null
  }
  const stale = read('ATOMIC_WATCHDOG_STALE_LIMIT_SECS')
  const poll = read('ATOMIC_WATCHDOG_POLL_INTERVAL_SECS')
  const grace = read('ATOMIC_WATCHDOG_KILL_GRACE_SECS')
  if (stale === null || poll === null || grace === null) return null
  return { stale_limit_secs: stale, poll_interval_secs: poll, kill_grace_secs: grace }
}

/**
 * The longest the watchdog script lets an engine run after the last heartbeat write: its
 * `THRESHOLD = (STALE_LIMIT + POLL) / POLL` unchanged polls (integer division, as the script's own
 * arithmetic), one more poll for where in its sleep the last write landed, then the TERM→KILL grace.
 */
export function watchdogExitBoundMs(timing: WatchdogTiming): number {
  const threshold = Math.floor(
    (timing.stale_limit_secs + timing.poll_interval_secs) / timing.poll_interval_secs
  )
  return ((threshold + 1) * timing.poll_interval_secs + timing.kill_grace_secs) * 1000
}

/** Gaps between successive distinct values of a sampled mtime (ms): how often the file was really written. */
export function heartbeatGaps(mtimesMs: readonly number[]): number[] {
  const gaps: number[] = []
  let previous: number | null = null
  for (const mtime of mtimesMs) {
    if (previous !== null && mtime !== previous) gaps.push(mtime - previous)
    previous = mtime
  }
  return gaps
}

export interface Summary {
  count: number
  min: number
  median: number
  max: number
}

/** Count, min, median (lower middle for an even count) and max; null for no values. */
export function summarize(values: readonly number[]): Summary | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return {
    count: sorted.length,
    min: sorted[0] as number,
    median: sorted[Math.floor((sorted.length - 1) / 2)] as number,
    max: sorted[sorted.length - 1] as number,
  }
}

/** `df -P -k <path>` (POSIX format): the `Used` column of its one data line, in bytes. */
export function parseDfUsedBytes(text: string): number | null {
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  if (lines.length < 2 || !/^Filesystem\s/.test(lines[0] as string)) return null
  const cells = (lines[lines.length - 1] as string).trim().split(/\s+/)
  const used = cells[2]
  return cells.length >= 6 && used !== undefined && /^[0-9]+$/.test(used) ? Number(used) * 1024 : null
}

export interface SourceConstant {
  value: number | string
  /** 1-based line of the name's own definition. */
  line: number
}

const NUMBER_LITERAL = /^-?[0-9][0-9_]*(\.[0-9]+)?$/
const STRING_LITERAL = /^(['"])(.*)\1$/
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/**
 * A constant as the source spells it: `export const NAME = <literal>` or an object field
 * `  NAME: <literal>,` (the first such line whose value is a literal, so an interface's `NAME: number`
 * is passed over). A value that names another `export const` of the same file is followed, so
 * `POLL = HEARTBEAT` reads as HEARTBEAT's number, still cited at POLL's own line.
 */
export function sourceConstant(text: string, name: string, depth = 0): SourceConstant | null {
  if (depth > 5) return null
  const lines = text.split('\n')
  const escaped = name.replace(/[$]/g, '\\$')
  const declaration = new RegExp(`^export const ${escaped}(?::[^=]+)? = (.+?)\\s*$`)
  const field = new RegExp(`^\\s+${escaped}: (.+?),?\\s*$`)
  for (const [index, line] of lines.entries()) {
    const raw = (declaration.exec(line) ?? field.exec(line))?.[1]
    if (raw === undefined) continue
    if (NUMBER_LITERAL.test(raw)) return { value: Number(raw.replace(/_/g, '')), line: index + 1 }
    const quoted = STRING_LITERAL.exec(raw)
    if (quoted !== null) return { value: quoted[2] as string, line: index + 1 }
    if (IDENTIFIER.test(raw) && raw !== name) {
      const target = sourceConstant(text, raw, depth + 1)
      if (
        target !== null &&
        new RegExp(`^export const ${raw.replace(/[$]/g, '\\$')}\\b`).test(lines[target.line - 1] ?? '')
      )
        return { value: target.value, line: index + 1 }
    }
  }
  return null
}

export interface CitedConstant {
  name: string
  /** `src/...:<line>`, or just the file when the name was not found there. */
  source: string
  value: number | string | null
}

/** Reads each `[file, name]` from the checkout at `root`; a missing file or name is reported with a null value. */
export function readSourceConstants(
  root: string,
  specs: ReadonlyArray<readonly [string, string]>
): CitedConstant[] {
  return specs.map(([file, name]) => {
    let text = ''
    try {
      text = readFileSync(join(root, file), 'utf8')
    } catch {
      return { name, source: file, value: null }
    }
    const found = sourceConstant(text, name)
    return found === null
      ? { name, source: file, value: null }
      : { name, source: `${file}:${found.line}`, value: found.value }
  })
}

/** The adapter's readiness timeout for `weightBytes`, restated: `ceil((base + perGiB * GiB) * margin)`. */
export function readinessTimeoutMs(
  weightBytes: number,
  coefficients: { base_ms: number; per_gib_ms: number; margin: number }
): number {
  const gib = Math.max(weightBytes, 0) / 1024 ** 3
  return Math.ceil((coefficients.base_ms + coefficients.per_gib_ms * gib) * coefficients.margin)
}

// ── Reading the machine ─────────────────────────────────────────────────────────────────────────

/** `docker inspect` of one container as root; null when Docker does not know it. */
export async function inspectContainer(id: string): Promise<ContainerFacts | null> {
  const out = await sudoDockerAsync(['inspect', id], 60_000)
  return out.code === 0 ? containerFacts(out.stdout) : null
}

/**
 * The `tensorrt-llm` containers one core instance created (its `atomic.instance_id` label), newest
 * first, full ids; `all` includes exited ones.
 */
export function ownContainers(instanceId: string, all = false): string[] {
  const out = sudoDocker([
    'ps',
    ...(all ? ['-a'] : []),
    '--no-trunc',
    '--filter',
    `label=atomic.instance_id=${instanceId}`,
    '--filter',
    'label=atomic.engine_id=tensorrt-llm',
    '--format',
    '{{.ID}}',
  ])
  return out.code === 0
    ? out.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    : []
}

/** Bytes in use on the container's `/dev/shm`, from a `df` run inside it; null when not observable. */
export async function shmUsedBytes(id: string): Promise<number | null> {
  const out = await sudoDockerAsync(['exec', id, 'df', '-P', '-k', '/dev/shm'], 30_000)
  return out.code === 0 ? parseDfUsedBytes(out.stdout) : null
}

/** The heartbeat file's mtime every `everyMs` for `durationMs` (ms since the epoch); a failed stat is skipped. */
export async function sampleMtimes(path: string, durationMs: number, everyMs: number): Promise<number[]> {
  const samples: number[] = []
  const end = Date.now() + durationMs
  while (Date.now() < end) {
    try {
      samples.push(statSync(path).mtimeMs)
    } catch {
      // Between a rename and the next write, or gone: the next sample decides.
    }
    await new Promise((resolve) => setTimeout(resolve, everyMs))
  }
  return samples
}

/** Files and bytes under `dir` (the engine cache); what this user cannot read is counted, not thrown. */
export function dirStats(dir: string): { files: number; bytes: number; unreadable: number } {
  const stats = { files: 0, bytes: 0, unreadable: 0 }
  const walk = (path: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(path)
    } catch {
      stats.unreadable++
      return
    }
    for (const name of entries) {
      const child = join(path, name)
      try {
        const info = statSync(child)
        if (info.isDirectory()) walk(child)
        else {
          stats.files++
          stats.bytes += info.size
        }
      } catch {
        stats.unreadable++
      }
    }
  }
  walk(dir)
  return stats
}

/**
 * A model's engine cache under `<data>/atomic-core/managed-runtimes/caches/<descriptor>/<model>`, or
 * the whole descriptor's without `modelId` (both names percent-encoded by the core), found by decoding
 * the names rather than re-encoding ours.
 */
export function findEngineCache(cachesDir: string, descriptorId: string, modelId?: string): string | null {
  const list = (dir: string): string[] => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  }
  const descriptorDir = list(cachesDir).find((name) => decodeName(name) === descriptorId)
  if (descriptorDir === undefined) return null
  if (modelId === undefined) return join(cachesDir, descriptorDir)
  const modelDir = list(join(cachesDir, descriptorDir)).find((name) => decodeName(name) === modelId)
  return modelDir === undefined ? null : join(cachesDir, descriptorDir, modelDir)
}

/**
 * The first file or directory under `dir` (depth first, `dir` itself excluded) that `uid` does not own:
 * what a container running as root leaves behind in a cache the user must be able to delete. Null when
 * everything is the user's, or `dir` cannot be read.
 */
export function firstForeignOwner(dir: string, uid: number): { path: string; uid: number } | null {
  let entries: string[]
  try {
    entries = readdirSync(dir).sort()
  } catch {
    return null
  }
  for (const name of entries) {
    const child = join(dir, name)
    let info: ReturnType<typeof lstatSync>
    try {
      info = lstatSync(child)
    } catch {
      continue
    }
    if (info.uid !== uid) return { path: child, uid: info.uid }
    if (info.isDirectory()) {
      const nested = firstForeignOwner(child, uid)
      if (nested !== null) return nested
    }
  }
  return null
}

/** One JSON Schema keyword set this test uses: `type`, `properties`, `required`, `additionalProperties: false`, `items`. */
export interface SmallSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean'
  properties?: Record<string, SmallSchema>
  required?: string[]
  additionalProperties?: boolean
  items?: SmallSchema
}

const jsonType = (value: unknown): string =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value

/**
 * Where `value` breaks `schema`, as `$.path` messages; empty when it conforms. Checked by hand for the
 * structured-output scenario (no schema library in this repo).
 */
export function schemaViolations(value: unknown, schema: SmallSchema, path = '$'): string[] {
  const actual = jsonType(value)
  const typeOk = schema.type === 'integer' ? Number.isInteger(value) : schema.type === actual
  if (!typeOk) return [`${path} should be ${schema.type}, is ${actual}`]
  if (schema.type === 'array') {
    const items = schema.items
    return items === undefined
      ? []
      : (value as unknown[]).flatMap((item, index) => schemaViolations(item, items, `${path}[${index}]`))
  }
  if (schema.type !== 'object') return []
  const object = value as Record<string, unknown>
  const problems: string[] = []
  for (const key of schema.required ?? []) if (!(key in object)) problems.push(`${path}.${key} is required`)
  for (const [key, field] of Object.entries(object)) {
    const property = schema.properties?.[key]
    if (property !== undefined) problems.push(...schemaViolations(field, property, `${path}.${key}`))
    else if (schema.additionalProperties === false) problems.push(`${path}.${key} is not allowed`)
  }
  return problems
}

/** The providers whose non-embedding sessions hold a GPU (llama.cpp on a GPU backend, MLX, TensorRT-LLM). */
const GPU_PROVIDERS = new Set(['llamacpp', 'llamacpp-upstream', 'mlx', 'tensorrt-llm'])

/** The chat sessions in `GET /sessions` that hold a GPU, per the core's residency rule (spec `gpu-residency`). */
export function residentGpuSessions<T extends { provider: string; is_embedding: boolean }>(
  sessions: readonly T[]
): T[] {
  return sessions.filter((s) => GPU_PROVIDERS.has(s.provider) && !s.is_embedding)
}

export interface LoadSamples {
  samples: number
  /** The card's highest `memory.used` seen while sampling; null on a unified-memory card. */
  vram_peak_bytes: number | null
  /** The engine container's highest `/dev/shm` use seen; null when it was never observable. */
  shm_peak_bytes: number | null
}

/**
 * Samples the card's memory and a container's `/dev/shm` every `everyMs` until `stop()`, while a load or
 * a request is in flight. For a load, containers of this core already running when it starts are
 * ignored, so the one a load is replacing never counts towards the new one's peak; `includeRunning`
 * samples the running one instead, for a request to a model that is already loaded.
 */
export function startSampler(options: {
  gpuUuid: string
  instanceId: string
  everyMs: number
  includeRunning?: boolean
}): {
  stop: () => Promise<LoadSamples>
} {
  const ignore = new Set(options.includeRunning === true ? [] : ownContainers(options.instanceId))
  const result: LoadSamples = { samples: 0, vram_peak_bytes: null, shm_peak_bytes: null }
  let stopped = false
  const max = (a: number | null, b: number | null): number | null =>
    a === null ? b : b === null ? a : Math.max(a, b)
  const loop = (async () => {
    while (!stopped) {
      const used = (await gpuMemoryUsed()).get(options.gpuUuid) ?? null
      result.vram_peak_bytes = max(result.vram_peak_bytes, used)
      const container = ownContainers(options.instanceId).find((id) => !ignore.has(id))
      if (container !== undefined)
        result.shm_peak_bytes = max(result.shm_peak_bytes, await shmUsedBytes(container))
      result.samples++
      await new Promise((resolve) => setTimeout(resolve, options.everyMs))
    }
  })()
  return {
    stop: async () => {
      stopped = true
      await loop
      return result
    },
  }
}
