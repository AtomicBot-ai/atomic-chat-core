/**
 * Wiring for `fake-llama-server.mjs`. The fake is a Node script, so it is launched as
 * `node <script> <the real llama argv>`: everything downstream — readiness markers, device log
 * parsing, exit classification, SIGTERM handling — is the production code path, and the only thing
 * swapped out is the executable itself. Using one launcher on every platform keeps Windows CI on
 * the same path as macOS and Linux.
 */
import { fileURLToPath } from 'node:url'
import { spawnAndAwaitReady, spawnManaged } from '../../src/runtime/index.js'
import type { ManagedProcess, ReadyOptions, SpawnSpec } from '../../src/runtime/index.js'

export const FAKE_LLAMA_SCRIPT = fileURLToPath(new URL('./fake-llama-server.mjs', import.meta.url))

export type FakeLlamaMode =
  | 'ready'
  | 'no-ready'
  | 'hang'
  | 'oom'
  | 'segv'
  | 'projector-fail'
  | 'mtp-fail'
  | 'tensor-count'
  | `exit-${number}`

export interface FakeLlamaOptions {
  mode?: FakeLlamaMode
  /** Print the CUDA backend, offload and buffer lines the device accumulator reads. */
  gpu?: boolean
  /** Delay the readiness line, to exercise the health poll and the timeout. */
  delayMs?: number
  /** Advertise `draft-dflash` in `-h` output. */
  specTypes?: string
  reply?: string
  /** Chat overflows the context while `--ctx-size` is below this. */
  minCtx?: number
  /** Path of a marker file: the first chat request creates it and fails with "Compute error". */
  computeErrorMarker?: string
  /** Every started fake appends its pid here, one per line: children that never became sessions. */
  pidFile?: string
  /**
   * Every started fake appends one JSON record here — pid, label, argv and the inference-relevant
   * environment — so a test can read the argv of a process that has already exited, which `ps`
   * cannot. One file per run holds every start, and `label` tells the providers apart.
   */
  argvFile?: string
  /** Names this pack in its `argvFile` records; the provider and release the launcher came from. */
  label?: string
  /** Scripted answers of the raw `/completion` endpoint, in order; `{{seen:TEXT}}` reports whether the prompt held TEXT. */
  completionSteps?: string[]
  /** One scripted tool turn: call this tool when it is offered, then repeat its result after the reply. */
  toolCall?: { name: string; arguments?: Record<string, unknown> }
  /**
   * A build with the decision role: `-h` lists `--decision`, and started with it the fake is a
   * decision server. `true` for the defaults (API version 1, router calibrated, no delays).
   */
  decision?: boolean | FakeDecisionOptions
  /** Embedding mode (`--embedding`): what the projector reads and whether the model refuses vectors. */
  embedding?: FakeEmbeddingOptions
}

export interface FakeEmbeddingOptions {
  /** With `--mmproj`, `/props.modalities` says `audio` as well as `vision`. */
  audio?: boolean
  /** `/v1/embeddings` answers 400, as llama.cpp does for a model without pooling. */
  refuse?: boolean
}

export interface FakeDecisionOptions {
  /** `/props.decision.api_version`; 1 by default. */
  apiVersion?: number
  /** `false`: no router calibration, `/v1/router/score` answers 501 unless allowed uncalibrated. */
  calibrated?: boolean
  /** Before each systemone / router answer. */
  delayMs?: number
  /** `/health` answers 503 this long after the start. */
  loadMs?: number
  /** `/v1/models` lists no `decision` capability. */
  noCapability?: boolean
  /** A build from before the converter: no `--decision-convert-cache`, `-m <folder>` fails. */
  noConvert?: boolean
  /**
   * Stock llama.cpp b11370+ with an upstream decision GGUF: decision without `--decision`, readiness
   * through `architecture.output_modalities`, no `/props.decision`, no router.
   */
  upstream?: boolean
}

function fakeEnv(options: FakeLlamaOptions): Record<string, string> {
  const env: Record<string, string> = { FAKE_LLAMA_MODE: options.mode ?? 'ready' }
  if (options.gpu) env['FAKE_LLAMA_GPU'] = '1'
  if (options.delayMs) env['FAKE_LLAMA_DELAY'] = String(options.delayMs)
  if (options.specTypes) env['FAKE_LLAMA_SPEC_TYPES'] = options.specTypes
  if (options.reply) env['FAKE_LLAMA_REPLY'] = options.reply
  if (options.minCtx) env['FAKE_LLAMA_MIN_CTX'] = String(options.minCtx)
  if (options.computeErrorMarker) env['FAKE_LLAMA_COMPUTE_ERROR_MARKER'] = options.computeErrorMarker
  if (options.pidFile) env['FAKE_LLAMA_PID_FILE'] = options.pidFile
  if (options.argvFile) env['FAKE_LLAMA_ARGV_FILE'] = options.argvFile
  if (options.label) env['FAKE_LLAMA_LABEL'] = options.label
  if (options.toolCall) env['FAKE_LLAMA_TOOL_CALL'] = JSON.stringify(options.toolCall)
  if (options.completionSteps) env['FAKE_LLAMA_COMPLETION_STEPS'] = JSON.stringify(options.completionSteps)
  if (options.decision) {
    const d = options.decision === true ? {} : options.decision
    env['FAKE_LLAMA_DECISION'] = '1'
    if (d.apiVersion !== undefined) env['FAKE_DECISION_API_VERSION'] = String(d.apiVersion)
    if (d.calibrated === false) env['FAKE_DECISION_CALIBRATED'] = '0'
    if (d.delayMs) env['FAKE_DECISION_DELAY_MS'] = String(d.delayMs)
    if (d.loadMs) env['FAKE_DECISION_LOAD_MS'] = String(d.loadMs)
    if (d.noCapability) env['FAKE_DECISION_NO_CAPABILITY'] = '1'
    if (d.noConvert) env['FAKE_DECISION_NO_CONVERT'] = '1'
    if (d.upstream) env['FAKE_DECISION_UPSTREAM'] = '1'
  }
  if (options.embedding?.audio) env['FAKE_EMBEDDING_AUDIO'] = '1'
  if (options.embedding?.refuse) env['FAKE_EMBEDDING_REFUSE'] = '1'
  return env
}

const rewrite = (spec: SpawnSpec, options: FakeLlamaOptions): SpawnSpec => ({
  exe: process.execPath,
  args: [FAKE_LLAMA_SCRIPT, ...spec.args],
  env: { ...spec.env, ...fakeEnv(options) },
  ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
})

/** Drop-in for `LlamacppRuntimeOptions.spawn`: same readiness logic, fake executable. */
export function fakeLlamaSpawn(options: FakeLlamaOptions = {}) {
  return (spec: SpawnSpec, opts: ReadyOptions) => spawnAndAwaitReady(rewrite(spec, options), opts)
}

/** Drop-in for one-shot probes (`--list-devices`, `-h`). */
export function fakeLlamaSpawnRaw(options: FakeLlamaOptions = {}) {
  return (spec: SpawnSpec): ManagedProcess => spawnManaged(rewrite(spec, options))
}

/**
 * Drop-in for the decision module's `spawn` seam: the fake as a decision-capable build (unless the
 * options say otherwise), started with the decision module's own argv and environment.
 */
export function fakeDecisionSpawn(options: FakeLlamaOptions = {}) {
  const withDecision = { ...options, decision: options.decision ?? true }
  return (spec: SpawnSpec, onLine: (stream: 'stdout' | 'stderr', line: string) => void): ManagedProcess =>
    spawnManaged(rewrite(spec, withDecision), onLine, { captureOutput: false })
}

/** The embedding module's spawn seam: the fake as a stock llama.cpp started with `--embedding`. */
export function fakeEmbeddingSpawn(options: FakeLlamaOptions = {}) {
  return (spec: SpawnSpec, onLine: (stream: 'stdout' | 'stderr', line: string) => void): ManagedProcess =>
    spawnManaged(rewrite(spec, options), onLine, { captureOutput: false })
}
