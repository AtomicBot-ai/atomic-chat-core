/**
 * Live TensorRT-LLM engine on every NVIDIA card of a real Linux host (openspec change
 * `add-tensorrt-llm-linux`, task 2.19; specs `tensorrt-llm-runtime`, `managed-session-gateway`,
 * `gpu-residency`, `tensorrt-llm-models`; design D8, D9, D11).
 *
 * The rest of the suite proves the provider against a fake Docker and a fake engine. This file is
 * the only proof that a real `trtllm-serve` container, pinned to one real card through the provider's
 * stored `gpu_id` setting (in the run's own data folder), loads a curated model
 * of that card's memory tier, runs as the core's own user, streams through the public server, starts
 * faster the second time from its engine cache, calls a tool through the parser the descriptor names,
 * answers a JSON schema where the family declares structured output (and is refused where it does
 * not), and — when the core dies with `kill -9` — is stopped by its own watchdog and gives the card's
 * memory back. With a llama.cpp build at hand it also races a TensorRT-LLM reload against a llama.cpp
 * GPU load, for the one-model-per-card rule (spec `gpu-residency`).
 *
 * It also measures what the design left open (design, open questions: the heartbeat interval, the
 * watchdog limit, `--shm-size` and the load timeout coefficients). It does not decide them: every
 * card's measurements go into `<out>/summary.json` next to the constants the core was built with,
 * cited by `src/` file and line, for a person to carry into an ADR (`docs/live-tests.md`).
 *
 * It drives the compiled core only (no `src/` imports). It never installs, removes or reconfigures
 * anything on the host: the engine must already be `ready` (the install test, task 2.18, or the app
 * or `atc`), and the test only loads and unloads models, reads Docker as root through `sudo -n`, and
 * kills the one core process it spawned itself.
 *
 * Runs only with ATOMIC_LIVE=1 on Linux with `/usr/bin/nvidia-smi`; anywhere else every scenario is
 * skipped with that reason. Optional: ATOMIC_LIVE_CORE_BIN, ATOMIC_RUNTIME_DESCRIPTOR_URL (default:
 * the conf fixture copy in this repo), ATOMIC_LIVE_MANAGED_ROOT (the managed root the engine was set
 * up in; default the per-user one), ATOMIC_LIVE_OUT, ATOMIC_LIVE_MODEL_CACHE, ATOMIC_LIVE_TRT_MODEL,
 * ATOMIC_LIVE_TRT_CONTEXT_LENGTH, ATOMIC_LIVE_TRT_VRAM_TOLERANCE_MIB, ATOMIC_LIVE_PUBLIC_PORT,
 * ATOMIC_LIVE_UPSTREAM_BIN and ATOMIC_LIVE_UPSTREAM_MODEL (the residency race), HF_ENDPOINT, HF_TOKEN. The core runs with DO_NOT_TRACK=1: a test run sends no error reports.
 */
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { contextLengthSettings, httpRequest, startLiveCore, streamChat } from '../helpers/live-core.js'
import type { HttpAnswer, LiveCore, StreamedChat } from '../helpers/live-core.js'
import {
  dirStats,
  dockerTimeMs,
  findEngineCache,
  firstForeignOwner,
  heartbeatGaps,
  inspectContainer,
  ownContainers,
  readinessTimeoutMs,
  readSourceConstants,
  residentGpuSessions,
  sampleMtimes,
  schemaViolations,
  shmUsedBytes,
  startSampler,
  summarize,
  watchdogExitBoundMs,
  watchdogTiming,
  WATCHDOG_EXIT_STALE_HEARTBEAT,
} from '../helpers/live-engine.js'
import type {
  CitedConstant,
  ContainerFacts,
  LoadSamples,
  SmallSchema,
  Summary,
} from '../helpers/live-engine.js'
import {
  fetchJson,
  fittingCuratedModels,
  pickTierModel,
  prepareCuratedModel,
  readDescriptor,
} from '../helpers/live-hf-model.js'
import type { CuratedModel, PreparedModel } from '../helpers/live-hf-model.js'
import {
  cardBytes,
  compareVersions,
  detectHost,
  gpuMemoryUsed,
  parseNvidiaSmi,
  run,
  sudoDocker,
} from '../helpers/live-linux-host.js'
import type { HostFacts, LiveGpu } from '../helpers/live-linux-host.js'
import { LiveReport } from '../helpers/live-report.js'

const NVIDIA_SMI = '/usr/bin/nvidia-smi'
const ENABLED = process.env['ATOMIC_LIVE'] === '1' && process.platform === 'linux' && existsSync(NVIDIA_SMI)
const GATE_REASON =
  process.env['ATOMIC_LIVE'] !== '1'
    ? 'ATOMIC_LIVE=1 is not set'
    : process.platform !== 'linux'
      ? `not Linux (${process.platform})`
      : `no ${NVIDIA_SMI} on this host: no NVIDIA driver, nothing to run the engine on`

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CPU = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
const BIN =
  process.env['ATOMIC_LIVE_CORE_BIN'] ?? join(ROOT, 'dist/bin', `atomic-chat-core-${CPU}-unknown-linux-gnu`)
const DESCRIPTOR_URL =
  process.env['ATOMIC_RUNTIME_DESCRIPTOR_URL'] ??
  pathToFileURL(join(ROOT, 'test/fixtures/runtimes/tensorrt-llm.json')).href
const MANAGED_ROOT = process.env['ATOMIC_LIVE_MANAGED_ROOT'] ?? null
const MODEL_CACHE =
  process.env['ATOMIC_LIVE_MODEL_CACHE'] ?? join(homedir(), '.cache', 'atomic-chat-live', 'hf')
const PUBLIC_PORT = Number(process.env['ATOMIC_LIVE_PUBLIC_PORT'] ?? 1337)
const CONTEXT_LENGTH = process.env['ATOMIC_LIVE_TRT_CONTEXT_LENGTH']
  ? Number(process.env['ATOMIC_LIVE_TRT_CONTEXT_LENGTH'])
  : null
/** A llama.cpp build and GGUF for the residency race, the same variables `llamacpp.test.ts` reads. */
const LLAMA_BIN = process.env['ATOMIC_LIVE_UPSTREAM_BIN'] ?? ''
const LLAMA_MODEL = process.env['ATOMIC_LIVE_UPSTREAM_MODEL'] ?? ''
const LLAMA_MODEL_ID = 'live-llama'
/** How long either load of the residency race may take before it counts as hung. */
const RACE_BOUND_MS = 30 * 60_000
const MIB = 1024 * 1024
/** How far above its pre-load level a card's used memory may settle after the engine exits. */
const VRAM_TOLERANCE_BYTES = Number(process.env['ATOMIC_LIVE_TRT_VRAM_TOLERANCE_MIB'] ?? 512) * MIB
/** Docker's own teardown and the driver releasing the CUDA context, on top of the watchdog's bound. */
const EXIT_SLACK_MS = 30_000
/** How long the card's memory may take to come back once the container has exited. */
const VRAM_RETURN_MS = 60_000
/** How long the heartbeat file is watched to measure how often the core really writes it. */
const HEARTBEAT_SAMPLE_MS = 20_000
const MIN = 60_000
const HOUR = 60 * MIN

/** The constants the measurements are compared against, read from this checkout's `src/` as text. */
const SOURCE_CONSTANTS = [
  ['src/runtime/container/watchdog.ts', 'DEFAULT_HEARTBEAT_INTERVAL_SECS'],
  ['src/runtime/container/watchdog.ts', 'DEFAULT_WATCHDOG_STALE_LIMIT_SECS'],
  ['src/runtime/container/watchdog.ts', 'DEFAULT_WATCHDOG_POLL_INTERVAL_SECS'],
  ['src/runtime/container/watchdog.ts', 'DEFAULT_WATCHDOG_KILL_GRACE_SECS'],
  ['src/runtime/container/argv.ts', 'MODEL_CONTAINER_SHM_SIZE'],
  ['src/runtime/container/argv.ts', 'MODEL_CONTAINER_SHM_SIZE_CEILING_GB'],
  ['src/runtime/tensorrt-llm/adapter.ts', 'TENSORRT_LLM_READINESS_BASE_MS'],
  ['src/runtime/tensorrt-llm/adapter.ts', 'TENSORRT_LLM_READINESS_PER_GIB_MS'],
  ['src/runtime/tensorrt-llm/adapter.ts', 'TENSORRT_LLM_READINESS_MARGIN'],
  ['src/runtime/managed-text/lifecycle.ts', 'heartbeatReadyTimeoutMs'],
  ['src/runtime/managed-text/lifecycle.ts', 'stopTimeoutSecs'],
  ['src/runtime/managed-text/lifecycle.ts', 'monitorIntervalMs'],
] as const

const CARD_SCENARIOS = [
  [
    'load',
    "the curated model of the card's memory tier loads pinned to this card (gpu_id), with stages and timings",
  ],
  [
    'container-user',
    "the engine container runs as the core's own uid:gid, and every file it wrote to the engine cache is the user's",
  ],
  [
    'stream',
    'a chat streams through the public server; the session gateway refuses a request without its key',
  ],
  ['reload-cached', 'unload with a confirmed stop, load again: the second load is faster (engine cache)'],
  ['tool-call', 'a model whose family has a tool parser answers a tool call through the parser'],
  [
    'structured-output',
    'a model whose family declares structured output answers a json_schema response_format with conforming JSON',
  ],
  [
    'structured-output-refused',
    'a model whose family does not declare structured output: the core refuses response_format, the engine never sees it',
  ],
  [
    'kill-core',
    'kill -9 of the core: the watchdog stops the container in its bound, and the card returns to its pre-load memory',
  ],
] as const
type CardScenario = (typeof CARD_SCENARIOS)[number][0]

/** The cards at collection time: every card gets its own named scenarios. Placeholder `gpu0` when skipped. */
function listCards(): LiveGpu[] {
  const out = run(NVIDIA_SMI, [
    '--query-gpu=uuid,name,compute_cap,memory.total,memory.free,driver_version',
    '--format=csv,noheader,nounits',
  ])
  return out.code === 0 ? parseNvidiaSmi(out.stdout) : []
}
const CARDS: LiveGpu[] = ENABLED ? listCards() : []
const CARD_COUNT = ENABLED ? CARDS.length : 1
const cardLabel = (index: number): string => CARDS[index]?.name ?? `gpu${index}`
const scenarioId = (index: number, key: CardScenario): string => `gpu${index}-${key}`
const SCENARIOS: Array<[string, string]> = [
  [
    'preconditions',
    'the host can run this test: a GPU and driver the descriptor accepts, Docker reachable, the engine ready',
  ],
  ...Array.from({ length: CARD_COUNT }, (_, index) =>
    CARD_SCENARIOS.map(([key, title]): [string, string] => [
      scenarioId(index, key),
      `${cardLabel(index)}: ${title}`,
    ])
  ).flat(),
  [
    'reload-while-other-loads',
    'a tensorrt-llm reload with a new context length races a llama.cpp GPU load: both settle, one GPU model stays resident',
  ],
]

interface Descriptor {
  descriptor_id: string
  minimum_driver_version: string
  minimum_compute_capability: string
  image: Record<string, { repository: string; digest: string }>
  curated_models: CuratedModel[]
  model_families: Record<
    string,
    { tool_parser: string | null; reasoning_parser: string | null; structured_output: boolean }
  >
  recipes: Array<{
    recipe_id: string
    distributions: Array<{ id: string; version_id: string; arch: string }>
  }>
}

interface SessionInfo {
  port: number
  api_key: string | null
  execution?: string
  generation?: string
}

interface LoadProgress {
  model_id: string
  generation: string
  stage: string
  elapsed_ms: number
  gpu_substituted?: { requested_gpu_id: string; gpu_id: string }
}

/** One load of one model on one card, as the test saw it. */
interface LoadRecord {
  model_id: string
  generation: string
  session: SessionInfo
  load_ms: number
  /** Each stage's `elapsed_ms` as the core reported it on `session:load-progress`. */
  stages: Array<{ stage: string; elapsed_ms: number }>
  gpu_substituted: LoadProgress['gpu_substituted'] | null
  container: ContainerFacts | null
  samples: LoadSamples
  vram_after_bytes: number | null
  weight_bytes: number
  /** The adapter's weight-based timeout for this model, from the `src/` coefficients. */
  readiness_timeout_ms: number | null
}

interface CardRun {
  index: number
  gpu: LiveGpu
  /** Why nothing runs on this card; null when it can. */
  unfit: string | null
  model: CuratedModel | null
  prepared: PreparedModel | null
  vram_baseline_bytes: number | null
  first_load: LoadRecord | null
  reload: LoadRecord | null
  unload_ms: number | null
  engine_cache: { path: string | null; files: number; bytes: number; unreadable: number } | null
  /** Loads the core refused or the engine did not survive, with the engine's log tail. */
  failed_loads: Array<Record<string, unknown>>
  container_user: Record<string, unknown> | null
  stream: Record<string, unknown> | null
  tool: Record<string, unknown> | null
  structured: Record<string, unknown> | null
  structured_refused: Record<string, unknown> | null
  kill: Record<string, unknown> | null
}

const S: {
  descriptor: Descriptor
  facts: HostFacts
  problems: string[]
  constants: CitedConstant[]
  out: string
  dataFolder: string
  coreEnv: Record<string, string>
  core: LiveCore | null
  cores: number
  closeEvents: (() => void) | null
  serverPort: number | null
  progress: LoadProgress[]
  /** The model of ours that is running now, and where. */
  loaded: {
    card: number
    modelId: string
    generation: string
    containerId: string | null
    session: SessionInfo
  } | null
  cards: CardRun[]
  /** Every model this run prepared, by the id the core knows it by. */
  prepared: Map<string, PreparedModel>
} = {
  descriptor: undefined as unknown as Descriptor,
  facts: undefined as unknown as HostFacts,
  problems: [],
  constants: [],
  out: '',
  dataFolder: '',
  coreEnv: {},
  core: null,
  cores: 0,
  closeEvents: null,
  serverPort: null,
  progress: [],
  loaded: null,
  cards: [],
  prepared: new Map(),
}
let report: LiveReport

/** Thrown by a scenario body that finds, once running, that it has nothing to exercise here. */
class ScenarioSkip extends Error {}

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const constant = (name: string): number | null => {
  const value = S.constants.find((c) => c.name === name)?.value
  return typeof value === 'number' ? value : null
}
const core = (): LiveCore => {
  if (S.core === null) throw new Error('no core is running')
  return S.core
}
/**
 * Pins the provider to `gpuId` the way the app does: the stored `gpu_id` setting, in this run's own
 * data folder (never the user's). ATOMIC_LIVE_TRT_CONTEXT_LENGTH goes in with it, so the check route
 * and every load size the KV reserve alike — a small card can be refused by the memory check
 * (weights plus the reserve for the context length) otherwise.
 */
async function pinCard(gpuId: string): Promise<void> {
  const values = { gpu_id: gpuId, ...contextLengthSettings(CONTEXT_LENGTH) }
  const answer = await core().api.patch('/settings/tensorrt-llm', { values })
  expect(answer.status, answer.text).toBe(200)
}
type Family = Descriptor['model_families'][string]
/** The descriptor's `model_families` entry for a checkpoint's architectures (the first one it names). */
const familyOf = (architectures: readonly string[]): Family | null =>
  architectures.map((a) => S.descriptor.model_families[a]).find((f) => f !== undefined) ?? null
const toolParserOf = (architectures: readonly string[]): string | null =>
  familyOf(architectures)?.tool_parser ?? null

/**
 * A model for a capability scenario on `card`: the one loaded there now when its family qualifies,
 * else the smallest curated model the card runs whose family does (its `config.json` fetched to find
 * out), prepared for loading. Null, with every model it looked at, when none qualifies.
 */
async function modelWhoseFamily(
  card: CardRun,
  qualifies: (family: Family | null) => boolean
): Promise<{ prepared: PreparedModel | null; checked: string[] }> {
  const checked: string[] = []
  const current = S.loaded?.card === card.index ? S.prepared.get(S.loaded.modelId) : undefined
  if (current !== undefined) {
    checked.push(`${current.model.repository} (${current.architectures.join(', ')})`)
    if (qualifies(familyOf(current.architectures))) return { prepared: current, checked }
  }
  for (const candidate of fittingCuratedModels(S.descriptor.curated_models, cardShape(card.gpu))) {
    if (candidate.repository === current?.model.repository) continue
    const known = [...S.prepared.values()].find((p) => p.model.repository === candidate.repository)
    const architectures =
      known?.architectures ??
      ((await fetchJson(candidate.repository, candidate.revision, 'config.json'))['architectures'] as
        string[] | undefined) ??
      []
    checked.push(`${candidate.repository} (${architectures.join(', ')})`)
    if (!qualifies(familyOf(architectures))) continue
    return { prepared: known ?? (await prepare(card, candidate)), checked }
  }
  return { prepared: null, checked }
}

/** `prepareCuratedModel` for `card`, remembered for later scenarios. */
async function prepare(card: CardRun, model: CuratedModel): Promise<PreparedModel> {
  const prepared = await prepareCuratedModel({
    api: (await ensureCore()).api,
    model,
    gpuId: card.gpu.uuid,
    dataFolder: S.dataFolder,
    cacheRoot: MODEL_CACHE,
    log: (line) => report.log(line),
  })
  S.prepared.set(prepared.id, prepared)
  return prepared
}

/** Makes `prepared` the model loaded on `card` (pinning the card first), unless it already is. */
async function ensureLoadedOn(card: CardRun, prepared: PreparedModel): Promise<LoadRecord | null> {
  await ensureCore()
  await pinCard(card.gpu.uuid)
  if (S.loaded?.modelId === prepared.id && S.loaded.card === card.index) return null
  return loadOnCard(card, prepared)
}
const cardShape = (gpu: LiveGpu): { total_bytes: number; compute_capability: string } => ({
  total_bytes: cardBytes(gpu),
  compute_capability: gpu.compute_capability,
})

async function startCore(): Promise<LiveCore> {
  S.cores++
  const label = `core-${S.cores}`
  const started = await startLiveCore({
    label,
    bin: BIN,
    dataFolder: S.dataFolder,
    env: S.coreEnv,
    logFile: join(S.out, 'core.log'),
  })
  report.log(
    `${label} ready: pid ${started.ready.pid}, instance ${started.ready.instance_id}, version ${started.ready.version}, control :${started.ready.control_port}`
  )
  S.progress = []
  const events = started.api.events((event, data) => {
    if (event !== 'session:load-progress') return
    const progress = data as LoadProgress
    S.progress.push(progress)
    report.log(`  load ${progress.model_id} ${progress.stage} at ${progress.elapsed_ms} ms`)
  })
  S.closeEvents = events.close
  S.core = started
  S.serverPort = null
  S.loaded = null
  return started
}

const ensureCore = async (): Promise<LiveCore> => S.core ?? (await startCore())

async function stopCore(): Promise<void> {
  S.closeEvents?.()
  S.closeEvents = null
  await S.core?.stop()
  S.core = null
  S.serverPort = null
  S.loaded = null
}

/** The public `/v1` server of the running core, started once per core. */
async function publicPort(): Promise<number> {
  if (S.serverPort !== null) return S.serverPort
  const server = await core().api.post<{ port: number }>('/server/start', { port: PUBLIC_PORT })
  expect(server.status, server.text).toBe(200)
  S.serverPort = server.body.port
  report.log(`public server on :${S.serverPort}`)
  return S.serverPort
}

/** The container this core runs for `generation` (identified by its heartbeat mount), inspected. */
async function containerOf(generation: string): Promise<ContainerFacts | null> {
  for (const id of ownContainers(core().ready.instance_id)) {
    const facts = await inspectContainer(id)
    if (facts?.generation === generation) return facts
  }
  return null
}

/**
 * Loads `prepared` on the pinned card (`pinCard` first), sampling the card and the container while it
 * loads. `overrides` are the load request's own (the residency race changes the context length).
 */
async function loadOnCard(
  card: CardRun,
  prepared: PreparedModel,
  overrides: Record<string, unknown> = {}
): Promise<LoadRecord> {
  const api = core().api
  const sampler = startSampler({
    gpuUuid: card.gpu.uuid,
    instanceId: core().ready.instance_id,
    everyMs: 2000,
  })
  const started = Date.now()
  let answer: HttpAnswer<{ session: SessionInfo }>
  let loadMs: number
  let samples: LoadSamples
  try {
    answer = await api.post<{ session: SessionInfo }>(
      `/models/tensorrt-llm/${prepared.id}/load`,
      Object.keys(overrides).length === 0 ? {} : { overrides },
      2 * HOUR
    )
  } finally {
    loadMs = Date.now() - started
    // Stopped however the request ended, so no sampler keeps polling Docker behind a failed load.
    samples = await sampler.stop()
  }
  report.log(
    `load of ${prepared.id} on gpu${card.index} answered ${answer.status} after ${(loadMs / 1000).toFixed(1)} s`
  )
  if (answer.status !== 200) {
    // Whatever ran before was stopped by this load's `stopping-previous`: nothing of ours is loaded now.
    S.loaded = null
    // The engine's own last words go into the report, not only the failure message: an engine that
    // cannot start (as a non-root user, for one) is diagnosed from them.
    const logs = await api
      .get<{ log_tail?: string; error?: unknown }>(`/models/tensorrt-llm/${prepared.id}/logs`)
      .catch(() => null)
    const logTail = (logs?.body?.log_tail ?? '').slice(-8000)
    card.failed_loads.push({
      model_id: prepared.id,
      status: answer.status,
      error: answer.body ?? answer.text.slice(0, 2000),
      log_error: logs?.body?.error ?? null,
      log_tail: logTail,
    })
    throw new Error(
      `load answered ${answer.status}: ${answer.text.slice(0, 2000)}\n--- engine log tail ---\n${logTail.slice(-4000)}`
    )
  }
  const session = answer.body.session
  const generation = session.generation ?? ''
  const ofThisLoad = (): LoadProgress[] =>
    S.progress.filter((p) => p.model_id === prepared.id && p.generation === generation)
  // The event stream is its own connection: its `ready` frame can land just after the load answered.
  await waitFor(async () => ofThisLoad().some((p) => p.stage === 'ready'), 10_000, 200)
  const progress = ofThisLoad()
  const container = await containerOf(generation)
  const weightBytes =
    prepared.check?.weight_bytes ??
    prepared.files.filter((f) => /^[^/]+\.safetensors$/.test(f.path)).reduce((sum, f) => sum + f.size, 0)
  const base = constant('TENSORRT_LLM_READINESS_BASE_MS')
  const perGib = constant('TENSORRT_LLM_READINESS_PER_GIB_MS')
  const margin = constant('TENSORRT_LLM_READINESS_MARGIN')
  const record: LoadRecord = {
    model_id: prepared.id,
    generation,
    session,
    load_ms: loadMs,
    stages: progress.map((p) => ({ stage: p.stage, elapsed_ms: p.elapsed_ms })),
    gpu_substituted: progress.find((p) => p.gpu_substituted !== undefined)?.gpu_substituted ?? null,
    container,
    samples,
    vram_after_bytes: (await gpuMemoryUsed()).get(card.gpu.uuid) ?? null,
    weight_bytes: weightBytes,
    readiness_timeout_ms:
      base === null || perGib === null || margin === null
        ? null
        : readinessTimeoutMs(weightBytes, { base_ms: base, per_gib_ms: perGib, margin }),
  }
  S.loaded = {
    card: card.index,
    modelId: prepared.id,
    generation,
    containerId: container?.id ?? null,
    session,
  }
  // Pinned means pinned: the container got exactly this card, and the core did not substitute another.
  expect(session.execution).toBe('container')
  expect(container, `no running container of this core carries generation ${generation}`).not.toBeNull()
  expect(container?.gpu_device_ids).toEqual([card.gpu.uuid])
  expect(record.gpu_substituted, 'the core loaded on another card than the pinned gpu_id').toBeNull()
  expect(record.stages.map((s) => s.stage)).toContain('ready')
  return record
}

/** Waits until `check` holds or `ms` passes; answers whether it held. */
async function waitFor(check: () => Promise<boolean>, ms: number, everyMs = 1000): Promise<boolean> {
  const deadline = Date.now() + ms
  for (;;) {
    if (await check()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, everyMs))
  }
}

/**
 * The llama.cpp build and GGUF of the residency race, put where the core finds them in this run's own
 * data folder, the way `llamacpp.test.ts` does: the whole build folder as a backend pack (llama-server
 * links against the ggml libraries beside it), and a `model.yml` pointing at the GGUF where it is.
 */
function installLlamaCpp(): void {
  const packDir = join(S.dataFolder, 'llamacpp-upstream', 'backends', 'b6325', 'live', 'build', 'bin')
  if (!existsSync(join(packDir, 'llama-server'))) {
    mkdirSync(packDir, { recursive: true })
    cpSync(dirname(LLAMA_BIN), packDir, { recursive: true })
    chmodSync(join(packDir, 'llama-server'), 0o755)
  }
  const modelDir = join(S.dataFolder, 'llamacpp', 'models', LLAMA_MODEL_ID)
  mkdirSync(modelDir, { recursive: true })
  const size = statSync(LLAMA_MODEL).size
  writeFileSync(
    join(modelDir, 'model.yml'),
    `model_path: ${LLAMA_MODEL}\nname: ${LLAMA_MODEL_ID}\nsize_bytes: ${size}\nmodel_size_bytes: ${size}\n`
  )
}

interface ChatAnswer {
  status: number
  text: string
  /** The body parsed; null when it was not JSON. */
  json: {
    choices?: Array<{
      finish_reason?: string
      message?: {
        content?: string | null
        tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>
      }
    }>
    error?: { code?: string; message?: string; type?: string }
  } | null
}

/** One non-streamed `POST /v1/chat/completions` on `port` (the public server, or a session gateway with its key). */
async function chat(port: number, body: Record<string, unknown>, apiKey?: string): Promise<ChatAnswer> {
  const answer = await httpRequest({
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    method: 'POST',
    ...(apiKey === undefined ? {} : { headers: { authorization: `Bearer ${apiKey}` } }),
    body: JSON.stringify(body),
    timeoutMs: 10 * MIN,
  })
  let json: ChatAnswer['json'] = null
  try {
    json = JSON.parse(answer.text) as ChatAnswer['json']
  } catch {
    json = null
  }
  return { status: answer.status, text: answer.text, json }
}

/** The structured-output scenarios' schema: small, and every key required. */
const CAPITAL_SCHEMA: SmallSchema = {
  type: 'object',
  properties: {
    city: { type: 'string' },
    country: { type: 'string' },
    population_millions: { type: 'number' },
  },
  required: ['city', 'country', 'population_millions'],
  additionalProperties: false,
}

/** What a card's run contributes to `summary.json`: its facts, statuses, durations and measurements. */
function cardSummary(card: CardRun): Record<string, unknown> {
  const loadView = (load: LoadRecord | null): Record<string, unknown> | null =>
    load === null
      ? null
      : {
          model_id: load.model_id,
          generation: load.generation,
          load_ms: load.load_ms,
          stages: load.stages,
          weight_bytes: load.weight_bytes,
          readiness_timeout_ms: load.readiness_timeout_ms,
          load_to_timeout:
            load.readiness_timeout_ms === null ? null : load.load_ms / load.readiness_timeout_ms,
          vram_peak_bytes: load.samples.vram_peak_bytes,
          vram_after_bytes: load.vram_after_bytes,
          shm_peak_bytes: load.samples.shm_peak_bytes,
          container_id: load.container?.id ?? null,
          command: load.container?.command ?? null,
        }
  return {
    index: card.index,
    uuid: card.gpu.uuid,
    name: card.gpu.name,
    compute_capability: card.gpu.compute_capability,
    driver_version: card.gpu.driver_version,
    total_bytes: card.gpu.total_bytes,
    unfit: card.unfit,
    model:
      card.model === null
        ? null
        : {
            repository: card.model.repository,
            revision: card.model.revision,
            vram_tier_bytes: card.model.vram_tier_bytes,
            quantization: card.prepared?.quantization ?? null,
            architectures: card.prepared?.architectures ?? null,
            bytes: card.prepared?.bytes ?? null,
            download_ms: card.prepared?.download_ms ?? null,
            check: card.prepared?.check ?? null,
          },
    scenarios: Object.fromEntries(
      CARD_SCENARIOS.map(([key]) => [key, report.status(scenarioId(card.index, key))])
    ),
    vram_baseline_bytes: card.vram_baseline_bytes,
    first_load: loadView(card.first_load),
    unload_ms: card.unload_ms,
    engine_cache: card.engine_cache,
    reload: loadView(card.reload),
    reload_to_first_load:
      card.first_load === null || card.reload === null ? null : card.reload.load_ms / card.first_load.load_ms,
    failed_loads: card.failed_loads,
    container_user: card.container_user,
    stream: card.stream,
    tool: card.tool,
    structured: card.structured,
    structured_refused: card.structured_refused,
    kill: card.kill,
  }
}

function flushCards(): void {
  report.section(
    'cards',
    S.cards.map((card) => cardSummary(card))
  )
}

/** Registers one scenario: skipped with its reason, or timed and recorded as passed or failed. */
function scenario(
  id: string,
  timeoutMs: number,
  skipReason: () => string | null,
  body: () => Promise<void>
): void {
  const title = SCENARIOS.find(([key]) => key === id)?.[1] ?? id
  it(
    `${id}: ${title}`,
    async (ctx) => {
      if (!ENABLED) {
        ctx.skip(GATE_REASON)
        return
      }
      const reason =
        id !== 'preconditions' && report.status('preconditions') !== 'passed'
          ? 'preconditions not met (see preconditions)'
          : skipReason()
      if (reason !== null) {
        report.finish(id, 'skipped', reason, null)
        ctx.skip(reason)
        return
      }
      const started = Date.now()
      try {
        await body()
        report.finish(id, 'passed', null, Date.now() - started)
      } catch (error) {
        if (error instanceof ScenarioSkip) {
          report.finish(id, 'skipped', error.message, null)
          ctx.skip(error.message)
          return
        }
        report.finish(id, 'failed', describeError(error), Date.now() - started)
        throw error
      } finally {
        if (id !== 'preconditions') flushCards()
      }
    },
    timeoutMs
  )
}

/** Why the host cannot run this test at all; empty when it can (the engine's readiness is checked with the core). */
function hostProblems(facts: HostFacts, descriptor: Descriptor): string[] {
  const problems: string[] = []
  if (!existsSync(BIN)) problems.push(`no core binary at ${BIN} (build it or set ATOMIC_LIVE_CORE_BIN)`)
  if (facts.gpus.length === 0) problems.push('nvidia-smi lists no NVIDIA GPU (driver or passthrough missing)')
  if (
    facts.driver_version !== null &&
    compareVersions(facts.driver_version, descriptor.minimum_driver_version) < 0
  )
    problems.push(
      `NVIDIA driver ${facts.driver_version} is older than the descriptor's minimum ${descriptor.minimum_driver_version}`
    )
  if (!facts.passwordless_sudo)
    problems.push(
      'passwordless sudo is required to inspect the engine container as root (`sudo -n true` failed)'
    )
  if (!facts.docker.user_reaches_daemon)
    problems.push(
      `${facts.user} cannot reach the Docker daemon in this session, and the core runs as ${facts.user}: ` +
        'log in again after the install test added you to the docker group, and run this from that login'
    )
  return problems
}

const needsCard = (index: number): string | null => S.cards[index]?.unfit ?? null
const needsFirstLoad = (index: number): string | null =>
  needsCard(index) ??
  (S.cards[index]?.first_load === null
    ? `the tier model did not load (see ${scenarioId(index, 'load')})`
    : null)
const needsLoadedHere = (index: number): string | null =>
  needsFirstLoad(index) ??
  (S.loaded?.card === index && S.core !== null
    ? null
    : `no model of this core is loaded on gpu${index} any more (see the scenarios before this one)`)

describe('TensorRT-LLM engine on every NVIDIA card of a real Linux host (task 2.19)', () => {
  beforeAll(async () => {
    if (!ENABLED) return
    S.descriptor = await readDescriptor<Descriptor>(DESCRIPTOR_URL)
    S.facts = detectHost(S.descriptor)
    S.problems = hostProblems(S.facts, S.descriptor)
    S.constants = readSourceConstants(ROOT, SOURCE_CONSTANTS)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const name = `${S.facts.os.id || 'linux'}-${S.facts.os.version_id ?? 'rolling'}-${S.facts.arch}-${stamp}`
    S.out = process.env['ATOMIC_LIVE_OUT'] ?? join(ROOT, 'test/tmp/live-tensorrt-llm', name)
    report = new LiveReport(S.out, SCENARIOS, { tag: 'tensorrt-llm', test: 'test/live/tensorrt-llm.test.ts' })
    S.dataFolder = join(S.out, 'data')
    mkdirSync(S.dataFolder, { recursive: true })
    S.coreEnv = {
      ATOMIC_RUNTIME_DESCRIPTOR_URL: DESCRIPTOR_URL,
      ...(MANAGED_ROOT === null ? {} : { ATOMIC_CORE_MANAGED_ROOT: MANAGED_ROOT }),
      HOME: homedir(),
      DO_NOT_TRACK: '1',
      XDG_RUNTIME_DIR: process.env['XDG_RUNTIME_DIR'] ?? `/run/user/${S.facts.uid}`,
    }
    const minimumCc = S.descriptor.minimum_compute_capability
    S.cards = CARDS.map((gpu, index) => {
      const shape = cardShape(gpu)
      let unfit: string | null = null
      let model: CuratedModel | null = null
      if (compareVersions(gpu.compute_capability, minimumCc) < 0)
        unfit = `compute capability ${gpu.compute_capability} is below the descriptor's minimum ${minimumCc}`
      else {
        // A non-curated ATOMIC_LIVE_TRT_MODEL throws here with its own message, failing the run early.
        model = pickTierModel(S.descriptor.curated_models, shape, process.env['ATOMIC_LIVE_TRT_MODEL'])
        if (model === null)
          unfit = `no curated model fits ${gpu.name} (${(shape.total_bytes / 1024 ** 3).toFixed(1)} GiB, cc ${gpu.compute_capability})`
      }
      return {
        index,
        gpu,
        unfit,
        model,
        prepared: null,
        vram_baseline_bytes: null,
        first_load: null,
        reload: null,
        unload_ms: null,
        engine_cache: null,
        failed_loads: [],
        container_user: null,
        stream: null,
        tool: null,
        structured: null,
        structured_refused: null,
        kill: null,
      }
    })
    report.section('core', {
      binary: BIN,
      version: run(BIN, ['--version']).stdout.trim(),
      sha256: existsSync(BIN) ? createHash('sha256').update(readFileSync(BIN)).digest('hex') : null,
      git_head: run('git', ['-C', ROOT, 'rev-parse', 'HEAD']).stdout.trim() || null,
      managed_root: MANAGED_ROOT ?? 'the per-user default (<dataDir>/atomic-managed-runtimes)',
    })
    report.section('descriptor', {
      url: DESCRIPTOR_URL,
      descriptor_id: S.descriptor.descriptor_id,
      minimum_driver_version: S.descriptor.minimum_driver_version,
      minimum_compute_capability: minimumCc,
    })
    report.section('host', S.facts)
    report.section('source_constants', S.constants)
    flushCards()
    report.log(`output folder ${S.out}`)
    report.log(
      `host: ${S.facts.os.pretty_name}, ${S.facts.arch}, kernel ${S.facts.kernel}, driver ${S.facts.driver_version ?? '-'}`
    )
    for (const card of S.cards)
      report.log(
        `gpu${card.index}: ${card.gpu.name} ${card.gpu.uuid} cc ${card.gpu.compute_capability} ` +
          `${card.gpu.total_bytes === null ? 'unified memory' : `${(card.gpu.total_bytes / 1024 ** 3).toFixed(1)} GiB`} → ` +
          `${card.model?.repository ?? card.unfit}`
      )
    for (const c of S.constants) report.log(`src constant ${c.name} = ${String(c.value)} (${c.source})`)
  }, 10 * MIN)

  afterAll(async () => {
    if (report === undefined) return
    if (S.core !== null && S.loaded !== null)
      await S.core.api
        .post(`/models/tensorrt-llm/${S.loaded.modelId}/unload`, {}, 10 * MIN)
        .catch(() => undefined)
    await stopCore().catch(() => undefined)
    flushCards()
    report.log(`\n${report.table()}`)
    for (const card of S.cards) {
      const kill = card.kill ?? {}
      report.log(
        `measured gpu${card.index} ${card.gpu.name}: load ${card.first_load?.load_ms ?? '-'} ms ` +
          `(timeout ${card.first_load?.readiness_timeout_ms ?? '-'} ms), reload ${card.reload?.load_ms ?? '-'} ms, ` +
          `first token ${String(card.stream?.['first_token_ms'] ?? '-')} ms, heartbeat gaps ${JSON.stringify(kill['heartbeat_gaps_ms'] ?? null)}, ` +
          `staleness ${String(kill['observed_staleness_ms'] ?? '-')} ms, shm peak ${String(kill['shm_peak_bytes'] ?? '-')} B`
      )
    }
  }, 20 * MIN)

  scenario(
    'preconditions',
    5 * MIN,
    () => null,
    async () => {
      expect(S.problems, S.problems.join('; ')).toEqual([])
      const started = await startCore()
      const snapshot = await started.api.get<{
        environments: Array<{
          availability: string
          installations: Array<{
            installation_id: string
            engine_id: string
            status: string
            active_descriptor_id: string | null
          }>
        }>
      }>('/snapshot')
      expect(snapshot.status, snapshot.text).toBe(200)
      const environment = snapshot.body.environments[0]
      const installation = environment?.installations.find((i) => i.engine_id === 'tensorrt-llm')
      report.detail('preconditions', 'environment', environment ?? null)
      if (installation?.status !== 'ready')
        throw new Error(
          `the managed TensorRT-LLM engine is not ready here (installation ${installation?.status ?? 'absent'} in ` +
            `${MANAGED_ROOT ?? 'the per-user managed root'}). This test never installs anything: run the install test ` +
            'first (test/live/managed-install.test.ts, see docs/live-tests.md) and pass its managed root with ' +
            'ATOMIC_LIVE_MANAGED_ROOT=<its output folder>/managed, or set the engine up with the app or atc.'
        )
      expect(
        installation.active_descriptor_id,
        `the engine is pinned to ${installation.active_descriptor_id}; point ATOMIC_RUNTIME_DESCRIPTOR_URL at that descriptor`
      ).toBe(S.descriptor.descriptor_id)
    }
  )

  for (let index = 0; index < CARD_COUNT; index++) {
    scenario(
      scenarioId(index, 'load'),
      3 * HOUR,
      () => needsCard(index),
      async () => {
        const card = S.cards[index] as CardRun
        const model = card.model as CuratedModel
        await ensureCore()
        await pinCard(card.gpu.uuid)
        report.log(`gpu${index} model: ${model.repository}@${model.revision} (${model.note})`)
        card.prepared = await prepare(card, model)
        if (card.prepared.check !== null) expect(card.prepared.check.checked_gpu_id).toBe(card.gpu.uuid)
        // Before anything of ours is on this card: the level its memory must come back to.
        card.vram_baseline_bytes = (await gpuMemoryUsed()).get(card.gpu.uuid) ?? null
        card.first_load = await loadOnCard(card, card.prepared)
        report.log(
          `gpu${index}: first load ${card.first_load.load_ms} ms, stages ${card.first_load.stages
            .map((s) => `${s.stage}@${s.elapsed_ms}`)
            .join(' ')}`
        )
      }
    )

    scenario(
      scenarioId(index, 'container-user'),
      10 * MIN,
      () => needsLoadedHere(index),
      async () => {
        const card = S.cards[index] as CardRun
        const loaded = S.loaded as NonNullable<typeof S.loaded>
        const uid = process.getuid?.() ?? -1
        const gid = process.getgid?.() ?? -1
        const container = loaded.containerId === null ? null : await inspectContainer(loaded.containerId)
        const cache = findEngineCache(
          join(S.dataFolder, 'atomic-core', 'managed-runtimes', 'caches'),
          S.descriptor.descriptor_id,
          loaded.modelId
        )
        const offender = cache === null ? null : firstForeignOwner(cache, uid)
        card.container_user = {
          expected: `${uid}:${gid}`,
          config_user: container?.user ?? null,
          engine_cache: cache,
          engine_cache_files: cache === null ? null : dirStats(cache),
          first_foreign_owner: offender,
        }
        report.log(
          `gpu${index}: container user ${container?.user ?? '(image default)'}, expected ${uid}:${gid}; ` +
            `engine cache ${offender === null ? 'all yours' : `${offender.path} is owned by uid ${offender.uid}`}`
        )
        expect(container, `container ${loaded.containerId} is not there to inspect`).not.toBeNull()
        expect(container?.user, "the engine container does not run as the core's own uid:gid").toBe(
          `${uid}:${gid}`
        )
        expect(cache, 'the load left no engine cache directory for the model').not.toBeNull()
        expect(
          offender,
          `${offender?.path} in the engine cache is owned by uid ${offender?.uid}, not ${uid}`
        ).toBeNull()
      }
    )

    scenario(
      scenarioId(index, 'stream'),
      30 * MIN,
      () => needsLoadedHere(index),
      async () => {
        const card = S.cards[index] as CardRun
        const loaded = S.loaded as NonNullable<typeof S.loaded>
        const port = await publicPort()
        const sampler = startSampler({
          gpuUuid: card.gpu.uuid,
          instanceId: core().ready.instance_id,
          everyMs: 1000,
        })
        let chat: StreamedChat
        let samples: LoadSamples
        try {
          chat = await streamChat({
            url: `http://127.0.0.1:${port}/v1/chat/completions`,
            body: {
              model: loaded.modelId,
              stream: true,
              max_tokens: 128,
              messages: [{ role: 'user', content: 'What is 2 + 2? Answer in one short sentence. /no_think' }],
            },
            timeoutMs: 10 * MIN,
          })
        } finally {
          samples = await sampler.stop()
        }
        // The session gateway (design D11): the session's own port refuses a request without its key.
        const gateway = `http://127.0.0.1:${loaded.session.port}/v1/models`
        const anonymous = await httpRequest({ url: gateway, method: 'GET', timeoutMs: MIN })
        const keyed = await httpRequest({
          url: gateway,
          method: 'GET',
          headers: { authorization: `Bearer ${loaded.session.api_key ?? ''}` },
          timeoutMs: MIN,
        })
        card.stream = {
          model_id: loaded.modelId,
          public_port: port,
          status: chat.status,
          first_token_ms: chat.first_token_ms,
          total_ms: chat.total_ms,
          answer: chat.content,
          reasoning: chat.reasoning.slice(0, 2000),
          vram_peak_bytes: samples.vram_peak_bytes,
          shm_peak_bytes: samples.shm_peak_bytes,
          gateway_without_key: anonymous.status,
          gateway_with_key: keyed.status,
        }
        report.log(
          `gpu${index} chat ${chat.status}: first token after ${chat.first_token_ms} ms, answer ${JSON.stringify(chat.content)}`
        )
        expect(chat.status, chat.text.slice(0, 2000)).toBe(200)
        expect(String(chat.headers['content-type'])).toContain('text/event-stream')
        expect(chat.text).toContain('data: [DONE]')
        expect(`${chat.content}${chat.reasoning}`.trim().length).toBeGreaterThan(0)
        expect(anonymous.status, 'the session gateway let a request without its key through').toBe(401)
        expect(keyed.status, keyed.text.slice(0, 500)).toBe(200)
      }
    )

    scenario(
      scenarioId(index, 'reload-cached'),
      3 * HOUR,
      () => needsLoadedHere(index),
      async () => {
        const card = S.cards[index] as CardRun
        const first = card.first_load as LoadRecord
        const loaded = S.loaded as NonNullable<typeof S.loaded>
        const started = Date.now()
        const unload = await core().api.post(`/models/tensorrt-llm/${loaded.modelId}/unload`, {}, 10 * MIN)
        card.unload_ms = Date.now() - started
        expect(unload.status, unload.text).toBe(200)
        S.loaded = null
        // "Stopped" means Docker says so (spec "Выгрузка ждёт подтверждённой остановки").
        if (loaded.containerId !== null) {
          const after = await inspectContainer(loaded.containerId)
          expect(after?.running ?? false, 'the container still runs after the unload answered').toBe(false)
        }
        const cachePath = findEngineCache(
          join(S.dataFolder, 'atomic-core', 'managed-runtimes', 'caches'),
          S.descriptor.descriptor_id,
          loaded.modelId
        )
        card.engine_cache = {
          path: cachePath,
          ...(cachePath === null ? { files: 0, bytes: 0, unreadable: 0 } : dirStats(cachePath)),
        }
        report.log(
          `gpu${index}: unloaded in ${card.unload_ms} ms; engine cache ${cachePath ?? 'not found'} holds ` +
            `${card.engine_cache.files} files, ${card.engine_cache.bytes} bytes`
        )
        card.reload = await loadOnCard(card, card.prepared as PreparedModel)
        report.log(
          `gpu${index}: reload ${card.reload.load_ms} ms vs first load ${first.load_ms} ms (${(
            card.reload.load_ms / first.load_ms
          ).toFixed(2)}×)`
        )
        expect(
          card.reload.load_ms,
          `the second load (${card.reload.load_ms} ms) was not faster than the first (${first.load_ms} ms)`
        ).toBeLessThan(first.load_ms)
      }
    )

    scenario(
      scenarioId(index, 'tool-call'),
      3 * HOUR,
      () => needsFirstLoad(index),
      async () => {
        const card = S.cards[index] as CardRun
        // The model loaded here when its family has a parser, else the smallest curated one that has.
        const found = await modelWhoseFamily(card, (family) => family?.tool_parser != null)
        if (found.prepared === null)
          throw new ScenarioSkip(
            `no curated model that fits ${card.gpu.name} has a tool parser in the descriptor's model_families (checked ${found.checked.join('; ')})`
          )
        const prepared = found.prepared
        const parser = toolParserOf(prepared.architectures) as string
        const load = await ensureLoadedOn(card, prepared)
        const loaded = S.loaded as NonNullable<typeof S.loaded>
        const container = load?.container ?? (await containerOf(loaded.generation))
        const capabilities = await core().api.get<{ tools?: boolean }>(
          `/models/tensorrt-llm/${prepared.id}/capabilities`
        )
        const started = Date.now()
        const answer = await chat(await publicPort(), {
          model: prepared.id,
          stream: false,
          max_tokens: 1024,
          tool_choice: 'auto',
          tools: [
            {
              type: 'function',
              function: {
                name: 'get_weather',
                description: 'The current weather in a city.',
                parameters: {
                  type: 'object',
                  properties: { city: { type: 'string', description: 'The city name, e.g. Berlin' } },
                  required: ['city'],
                },
              },
            },
          ],
          messages: [
            {
              role: 'user',
              content: 'What is the weather in Paris right now? Use the get_weather tool. /no_think',
            },
          ],
        })
        const body = answer.json ?? {}
        const choice = body.choices?.[0]
        const call = choice?.message?.tool_calls?.[0]?.function
        let args: Record<string, unknown> | null = null
        try {
          args = JSON.parse(call?.arguments ?? 'null') as Record<string, unknown> | null
        } catch {
          args = null
        }
        card.tool = {
          model_id: prepared.id,
          repository: prepared.model.repository,
          architectures: prepared.architectures,
          tool_parser: parser,
          loaded_for_this_scenario: load === null ? null : load.load_ms,
          engine_command: container?.command ?? null,
          capabilities_tools: capabilities.body?.tools ?? null,
          status: answer.status,
          ms: Date.now() - started,
          finish_reason: choice?.finish_reason ?? null,
          tool_calls: choice?.message?.tool_calls ?? null,
          content: (choice?.message?.content ?? '').slice(0, 2000),
          raw: body.choices === undefined ? answer.text.slice(0, 2000) : undefined,
        }
        report.log(
          `gpu${index} tool call ${answer.status}: ${JSON.stringify(choice?.message?.tool_calls ?? null)}`
        )
        expect(capabilities.body?.tools, 'capabilities do not declare tools for a family with a parser').toBe(
          true
        )
        expect(container?.command, "the engine was not started with the descriptor's --tool_parser").toEqual(
          expect.arrayContaining(['--tool_parser', parser])
        )
        expect(answer.status, answer.text.slice(0, 2000)).toBe(200)
        expect(call?.name, `no get_weather call in ${answer.text.slice(0, 2000)}`).toBe('get_weather')
        expect(String(args?.['city'] ?? ''), `arguments ${call?.arguments}`).toMatch(/paris/i)
      }
    )

    scenario(
      scenarioId(index, 'structured-output'),
      3 * HOUR,
      () => needsFirstLoad(index),
      async () => {
        const card = S.cards[index] as CardRun
        const found = await modelWhoseFamily(card, (family) => family?.structured_output === true)
        if (found.prepared === null)
          throw new ScenarioSkip(
            `no curated model that fits ${card.gpu.name} has a family with structured_output: true (checked ${found.checked.join('; ')})`
          )
        const prepared = found.prepared
        const load = await ensureLoadedOn(card, prepared)
        const capabilities = await core().api.get<{ structured_output?: boolean }>(
          `/models/tensorrt-llm/${prepared.id}/capabilities`
        )
        const answer = await chat(await publicPort(), {
          model: prepared.id,
          stream: false,
          max_tokens: 512,
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'capital', strict: true, schema: CAPITAL_SCHEMA },
          },
          messages: [
            {
              role: 'user',
              content:
                'What is the capital of France? Answer with its city, country and population in millions. /no_think',
            },
          ],
        })
        const content = answer.json?.choices?.[0]?.message?.content ?? ''
        let parsed: unknown
        let parseError: string | null = null
        try {
          parsed = JSON.parse(content.trim())
        } catch (error) {
          parseError = describeError(error)
        }
        const violations = parseError === null ? schemaViolations(parsed, CAPITAL_SCHEMA) : []
        card.structured = {
          model_id: prepared.id,
          repository: prepared.model.repository,
          architectures: prepared.architectures,
          loaded_for_this_scenario: load === null ? null : load.load_ms,
          capabilities_structured_output: capabilities.body?.structured_output ?? null,
          status: answer.status,
          content: content.slice(0, 2000),
          parse_error: parseError,
          violations,
          raw: answer.json === null ? answer.text.slice(0, 2000) : undefined,
        }
        report.log(`gpu${index} structured output ${answer.status}: ${JSON.stringify(content.slice(0, 300))}`)
        expect(capabilities.body?.structured_output, 'capabilities do not declare structured output').toBe(
          true
        )
        expect(answer.status, answer.text.slice(0, 2000)).toBe(200)
        expect(parseError, `the content is not JSON: ${content.slice(0, 500)}`).toBeNull()
        expect(violations, `the content breaks the schema: ${content.slice(0, 500)}`).toEqual([])
      }
    )

    scenario(
      scenarioId(index, 'structured-output-refused'),
      3 * HOUR,
      () => needsFirstLoad(index),
      async () => {
        const card = S.cards[index] as CardRun
        const found = await modelWhoseFamily(
          card,
          (family) => family !== null && family.structured_output === false
        )
        if (found.prepared === null)
          throw new ScenarioSkip(
            `no curated model that fits ${card.gpu.name} has a family with structured_output: false (checked ${found.checked.join('; ')})`
          )
        const prepared = found.prepared
        const load = await ensureLoadedOn(card, prepared)
        const loaded = S.loaded as NonNullable<typeof S.loaded>
        const body = {
          model: prepared.id,
          stream: false,
          max_tokens: 64,
          response_format: { type: 'json_schema', json_schema: { name: 'capital', schema: CAPITAL_SCHEMA } },
          messages: [{ role: 'user', content: 'What is the capital of France?' }],
        }
        // Both doors refuse it: the public server, and the session gateway in front of the engine.
        const publicAnswer = await chat(await publicPort(), body)
        const gatewayAnswer = await chat(loaded.session.port, body, loaded.session.api_key ?? '')
        card.structured_refused = {
          model_id: prepared.id,
          repository: prepared.model.repository,
          architectures: prepared.architectures,
          loaded_for_this_scenario: load === null ? null : load.load_ms,
          public: {
            status: publicAnswer.status,
            error: publicAnswer.json?.error ?? publicAnswer.text.slice(0, 500),
          },
          gateway: {
            status: gatewayAnswer.status,
            error: gatewayAnswer.json?.error ?? gatewayAnswer.text.slice(0, 500),
          },
        }
        report.log(
          `gpu${index} structured output refused: public ${publicAnswer.status} ${publicAnswer.json?.error?.code ?? ''}, ` +
            `gateway ${gatewayAnswer.status} ${gatewayAnswer.json?.error?.code ?? ''}`
        )
        // `unsupported_capability` is the core's own code; the engine answering would not use it.
        for (const answer of [publicAnswer, gatewayAnswer]) {
          expect(answer.status, answer.text.slice(0, 500)).toBe(400)
          expect(answer.json?.error?.code, answer.text.slice(0, 500)).toBe('unsupported_capability')
        }
      }
    )

    scenario(
      scenarioId(index, 'kill-core'),
      30 * MIN,
      () => needsLoadedHere(index),
      async () => {
        const card = S.cards[index] as CardRun
        const loaded = S.loaded as NonNullable<typeof S.loaded>
        const victim = core()
        // Only ever the process this test spawned: startLiveCore runs the binary itself, not through sudo.
        expect(victim.child.pid, 'the core under test is not the process this test spawned').toBe(
          victim.ready.pid
        )
        expect(loaded.containerId, 'no container id for the loaded model').not.toBeNull()
        const id = loaded.containerId as string
        const before = await inspectContainer(id)
        expect(before?.running, `container ${id} is not running before the kill`).toBe(true)
        const facts = before as ContainerFacts
        const timing = watchdogTiming(facts.watchdog_env)
        expect(
          timing,
          `no watchdog timing in the container's env: ${JSON.stringify(facts.watchdog_env)}`
        ).not.toBeNull()
        const heartbeat = facts.heartbeat_source === null ? null : join(facts.heartbeat_source, 'heartbeat')
        expect(heartbeat !== null && existsSync(heartbeat), `no heartbeat file at ${heartbeat}`).toBe(true)
        const heartbeatFile = heartbeat as string

        // How often the core really writes the heartbeat, and what /dev/shm holds after inference.
        const gaps = heartbeatGaps(await sampleMtimes(heartbeatFile, HEARTBEAT_SAMPLE_MS, 100))
        const shmNow = await shmUsedBytes(id)
        const shmPeak = [
          card.first_load?.samples.shm_peak_bytes,
          card.reload?.samples.shm_peak_bytes,
          card.stream?.['shm_peak_bytes'] as number | null | undefined,
          shmNow,
        ].reduce<number | null>((peak, v) => (typeof v === 'number' ? Math.max(peak ?? 0, v) : peak), null)

        const killedAt = Date.now()
        process.kill(victim.ready.pid, 'SIGKILL')
        S.closeEvents?.()
        S.closeEvents = null
        await new Promise<void>((resolve) => {
          if (victim.child.exitCode !== null || victim.child.signalCode !== null) resolve()
          else victim.child.once('exit', () => resolve())
        })
        S.core = null
        S.serverPort = null
        S.loaded = null
        report.log(`gpu${index}: killed core pid ${victim.ready.pid} with SIGKILL; waiting for the watchdog`)

        const bound = watchdogExitBoundMs(timing as NonNullable<typeof timing>)
        let exited: ContainerFacts | null = null
        await waitFor(async () => {
          exited = await inspectContainer(id)
          return exited !== null && !exited.running
        }, bound + EXIT_SLACK_MS)
        const detectedMs = Date.now() - killedAt
        const after = exited as ContainerFacts | null
        // Read after the exit: a write that landed between the sampling and the kill still counts.
        let lastBeat: number | null = null
        try {
          lastBeat = statSync(heartbeatFile).mtimeMs
        } catch {
          lastBeat = null
        }
        const finishedAt = dockerTimeMs(after?.finished_at ?? null)
        const tail = sudoDocker(['logs', '--tail', '20', id])
        const watchdogLine =
          `${tail.stdout}\n${tail.stderr}`.split('\n').find((line) => line.includes('atomic-watchdog:')) ??
          null

        let vramAfter: number | null = null
        let vramReturned: boolean | null = null
        if (card.vram_baseline_bytes !== null && after !== null && !after.running) {
          const baseline = card.vram_baseline_bytes
          vramReturned = await waitFor(async () => {
            vramAfter = (await gpuMemoryUsed()).get(card.gpu.uuid) ?? null
            return vramAfter !== null && vramAfter <= baseline + VRAM_TOLERANCE_BYTES
          }, VRAM_RETURN_MS)
        }

        card.kill = {
          container_id: id,
          heartbeat_file: heartbeatFile,
          heartbeat_gaps_ms: summarize(gaps) satisfies Summary | null,
          watchdog_env: facts.watchdog_env,
          watchdog_exit_bound_ms: bound,
          container_memory_limit_bytes: facts.memory_limit_bytes,
          container_memory_swap_bytes: facts.memory_swap_bytes,
          shm_size_bytes: facts.shm_size_bytes,
          shm_used_after_inference_bytes: shmNow,
          shm_peak_bytes: shmPeak,
          exit_code: after?.exit_code ?? null,
          kill_to_exit_ms: finishedAt === null ? null : finishedAt - killedAt,
          kill_to_detected_ms: detectedMs,
          observed_staleness_ms: finishedAt === null || lastBeat === null ? null : finishedAt - lastBeat,
          watchdog_log_line: watchdogLine,
          vram_baseline_bytes: card.vram_baseline_bytes,
          vram_after_exit_bytes: vramAfter,
          vram_tolerance_bytes: VRAM_TOLERANCE_BYTES,
          vram_returned: vramReturned,
        }
        report.log(
          `gpu${index}: container exited ${after?.running === false ? `with ${after.exit_code}` : 'NOT'} ` +
            `${String(card.kill['kill_to_exit_ms'])} ms after the kill (bound ${bound} ms + ${EXIT_SLACK_MS} ms slack); ` +
            `VRAM ${vramAfter ?? '-'} vs baseline ${card.vram_baseline_bytes ?? '-'} bytes`
        )

        // A new core on the same data folder removes what the killed one left (its execution journal),
        // and is the core the next card runs on. Recorded, not asserted: this scenario is about the
        // watchdog, and a restart that fails must not hide its verdict.
        try {
          const next = await startCore()
          const reconciled = await waitFor(
            async () => !ownContainers(victim.ready.instance_id, true).includes(id),
            MIN
          )
          card.kill['reconciled_by_next_core'] = reconciled
          report.log(
            `gpu${index}: the next core ${reconciled ? 'removed' : 'did NOT remove'} the killed core's container (${next.ready.instance_id})`
          )
        } catch (error) {
          card.kill['reconciled_by_next_core'] = null
          report.log(`gpu${index}: the next core did not start: ${describeError(error)}`)
        }

        expect(
          after?.running,
          `container ${id} still runs ${bound + EXIT_SLACK_MS} ms after kill -9 of the core`
        ).toBe(false)
        expect(
          after?.exit_code,
          `the container did not exit through the watchdog: ${watchdogLine ?? 'no watchdog line'}`
        ).toBe(WATCHDOG_EXIT_STALE_HEARTBEAT)
        if (card.vram_baseline_bytes === null)
          report.log(`gpu${index}: unified memory (no memory.used); the VRAM check does not apply`)
        else
          expect(
            vramReturned,
            `card memory ${vramAfter} bytes did not return to ${card.vram_baseline_bytes} ± ${VRAM_TOLERANCE_BYTES} within ${VRAM_RETURN_MS} ms`
          ).toBe(true)
      }
    )
  }

  scenario(
    'reload-while-other-loads',
    2 * HOUR,
    () => {
      if (LLAMA_BIN === '' || LLAMA_MODEL === '')
        return (
          'llama.cpp is not available to the core: set ATOMIC_LIVE_UPSTREAM_BIN (a CUDA build of llama-server; ' +
          'its whole folder is copied) and ATOMIC_LIVE_UPSTREAM_MODEL (a small GGUF)'
        )
      if (!existsSync(LLAMA_BIN) || !existsSync(LLAMA_MODEL))
        return `ATOMIC_LIVE_UPSTREAM_BIN or ATOMIC_LIVE_UPSTREAM_MODEL names a missing file (${LLAMA_BIN}, ${LLAMA_MODEL})`
      return S.cards.some((c) => c.first_load !== null)
        ? null
        : 'no card loaded its tier model (see the gpu<N>-load scenarios)'
    },
    async () => {
      const card = S.cards.find((c) => c.first_load !== null) as CardRun
      const prepared = card.prepared as PreparedModel
      installLlamaCpp()
      await ensureLoadedOn(card, prepared)
      const api = core().api
      const context = (CONTEXT_LENGTH ?? 8192) === 4096 ? 2048 : 4096
      const settle = async (
        label: string,
        call: Promise<HttpAnswer<unknown>>
      ): Promise<Record<string, unknown>> => {
        const started = Date.now()
        try {
          const answer = await call
          return {
            label,
            status: answer.status,
            ms: Date.now() - started,
            body: answer.body ?? answer.text.slice(0, 1000),
          }
        } catch (error) {
          return { label, status: null, ms: Date.now() - started, error: describeError(error) }
        }
      }
      // The llama.cpp load goes first, so its claim on every card is in place when the reload asks.
      const llama = settle(
        'llamacpp-upstream',
        api.post(
          `/models/llamacpp-upstream/${LLAMA_MODEL_ID}/load`,
          { overrides: { ctx_size: 2048 } },
          RACE_BOUND_MS
        )
      )
      await new Promise((resolve) => setTimeout(resolve, 250))
      const trt = settle(
        'tensorrt-llm',
        api.post(
          `/models/tensorrt-llm/${prepared.id}/load`,
          { overrides: contextLengthSettings(context) },
          RACE_BOUND_MS
        )
      )
      const results = await Promise.all([llama, trt])
      // Settled means answered, either way: a hung call is the deadlock this scenario is about.
      const sessions = await api.get<{
        sessions: Array<
          SessionInfo & { provider: string; model_id: string; is_embedding: boolean; pid: number | null }
        >
      }>('/sessions')
      const resident = residentGpuSessions(sessions.body?.sessions ?? [])
      const containers = ownContainers(core().ready.instance_id)
      const race = {
        card: card.index,
        trt_model: prepared.id,
        trt_context_length: context,
        calls: results,
        resident: resident.map((r) => ({ provider: r.provider, model_id: r.model_id, pid: r.pid })),
        running_trt_containers: containers,
      }
      report.section('reload_while_other_loads', race)
      report.log(
        `race: ${results.map((r) => `${String(r['label'])} ${String(r['status'])} in ${String(r['ms'])} ms`).join(', ')}; ` +
          `resident ${resident.map((r) => `${r.provider}/${r.model_id}`).join(', ') || 'none'}`
      )
      // What the core now holds decides what the rest of the run can assume.
      const trtSession = resident.find((r) => r.provider === 'tensorrt-llm')
      S.loaded =
        trtSession === undefined
          ? null
          : {
              card: card.index,
              modelId: trtSession.model_id,
              generation: trtSession.generation ?? '',
              containerId: containers[0] ?? null,
              session: trtSession,
            }
      const llamaSession = resident.find((r) => r.provider === 'llamacpp-upstream')
      if (llamaSession !== undefined)
        await api
          .post(`/models/llamacpp-upstream/${LLAMA_MODEL_ID}/unload`, {}, 5 * MIN)
          .catch(() => undefined)

      for (const result of results)
        expect(
          result['error'],
          `${String(result['label'])} did not answer (bound ${RACE_BOUND_MS} ms): ${String(result['error'])}`
        ).toBeUndefined()
      expect(
        resident.map((r) => `${r.provider}/${r.model_id}`),
        'exactly one GPU model may stay resident: the llama.cpp session holds every card'
      ).toHaveLength(1)
      expect(containers.length, 'running tensorrt-llm containers vs a resident tensorrt-llm session').toBe(
        trtSession === undefined ? 0 : 1
      )
    }
  )
})
