/**
 * The decision process's argv, environment and thread count. Pure.
 *
 * Built here and never through the chat `args.ts`: that builder serves chat and embedding sessions
 * (a GGUF without a chat head gets `--embedding --pooling mean`), and none of its flags mean anything
 * to `--decision`, which ignores most of them with a warning. The argv follows DECISION.md:
 *
 *   llama-server --decision -m <gguf | checkpoint dir> [--decision-spec <file>] [-a <id>]
 *                [--decision-convert-cache <dir> --decision-convert-type <f16|f32>] --device none -t <n>
 *                --host 127.0.0.1 --port <p> --no-webui [--decision-allow-uncalibrated]
 *
 * The key travels in `LLAMA_API_KEY`, never in argv, where any local user could read it with `ps`.
 *
 * `-t` is always passed. The engine's precedence (atomic-llama-cpp-turboquant `server-decision.cpp`,
 * `engine-laya.cpp`): the laya engine runs with `-t`, or without it llama.cpp's own default
 * (`common_cpu_get_num_math`: the performance cores on Apple silicon and on hybrid Linux x86, the
 * physical cores elsewhere, uncapped). A spec's `plan.n_threads` is never applied: the engine only
 * warns when it differs from the thread count it runs with, because logits are bitwise stable only
 * for a fixed count. So leaving `-t` out would not hand the choice to the spec, only to llama.cpp,
 * and would lose the cap below.
 */

import { isAbsolute, join, win32 } from 'node:path'
import type { DecisionConvertType } from '../contracts/index.js'

/** The environment variable the server's auth middleware reads (as `--api-key`), the fork's and upstream's. */
export const DECISION_API_KEY_ENV = 'LLAMA_API_KEY'

/**
 * Where checkpoint folders are converted to, relative to the data folder. Ours rather than the
 * engine's default (the OS user cache): it goes away with the app's data and does not depend on
 * `LLAMA_CACHE`. The engine never deletes old entries; the decision service does.
 */
export const DECISION_CONVERT_CACHE_DIR = join('decision', 'gguf-cache')

/**
 * A configured file as an absolute path: absolute as given, relative against the data folder, empty
 * as `undefined`. The core invents no folder for decision models; the app decides where they live.
 */
export function resolveDataPath(dataFolder: string, configured: string): string | undefined {
  const trimmed = configured.trim()
  if (trimmed === '') return undefined
  return isAbsolute(trimmed) || win32.isAbsolute(trimmed) ? trimmed : join(dataFolder, trimmed)
}

/** Loopback only: the public server forwards to it, nothing else should reach it. */
export const DECISION_HOST = '127.0.0.1'

/**
 * Ceiling of the automatic thread count. The laya encoder is one CPU graph per request, and the chat
 * model runs beside it; past eight threads the decision model mostly competes with the chat model
 * (plan KPI K8) instead of getting faster. An explicit `threads` setting is not capped.
 */
export const MAX_AUTO_THREADS = 8

export interface DecisionLaunchSpec {
  modelPath: string
  /** `--decision-spec`; omitted when empty. */
  specPath?: string
  /** `-a`; omitted when empty (the engine then answers with the file name). */
  modelId?: string
  /**
   * `modelPath` is a checkpoint folder: where the engine caches its conversion and in which type.
   * Passed in argv, never through `LLAMA_ARG_DECISION_*`, which `withoutDecisionEnv` strips.
   */
  convert?: { cacheDir: string; type: DecisionConvertType }
  threads: number
  port: number
  allowUncalibrated?: boolean
}

export function buildDecisionArgs(spec: DecisionLaunchSpec): string[] {
  const argv = ['--decision', '-m', spec.modelPath]
  if (spec.specPath) argv.push('--decision-spec', spec.specPath)
  if (spec.modelId) argv.push('-a', spec.modelId)
  if (spec.convert)
    argv.push('--decision-convert-cache', spec.convert.cacheDir, '--decision-convert-type', spec.convert.type)
  // The laya engine is CPU only and ignores `--device`; it is still said out loud so a future engine
  // that could use a GPU does not take VRAM the chat model counted on.
  argv.push('--device', 'none')
  argv.push('-t', String(spec.threads))
  argv.push('--host', DECISION_HOST, '--port', String(spec.port))
  argv.push('--no-webui')
  if (spec.allowUncalibrated) argv.push('--decision-allow-uncalibrated')
  return argv
}

/** What an upstream decision GGUF is started with, beyond the model and the port. */
export interface UpstreamDecisionLaunch {
  /** `--mmproj`, for a model that reads images. */
  mmprojPath?: string
  /** `-c`, and `-b`: the decision outputs are read from one batch, so it holds the whole prompt. */
  ctxSize: number
  /** `-ub` too (laya, kev, clef): their scores come out of the embeddings, one ubatch for the prompt. */
  wholePromptUbatch: boolean
}

/**
 * The argv of stock llama.cpp (b11370 on) for a GGUF with `<arch>.decision.type`: no decision flag,
 * the server reads the type from the file and serves `/v1/systemone` (and turns on embedding mode
 * itself where the type needs it). No `--device none`: upstream decision models run up to 27B
 * parameters, and the server's own fitting puts them on the GPU when there is room.
 *
 *   llama-server -m <gguf> [--mmproj <file>] [-a <id>] -c <n> -b <n> [-ub <n>] -t <n>
 *                --host 127.0.0.1 --port <p> --no-webui
 */
export function buildUpstreamDecisionArgs(
  spec: Pick<DecisionLaunchSpec, 'modelPath' | 'modelId' | 'threads' | 'port'>,
  upstream: UpstreamDecisionLaunch
): string[] {
  const argv = ['-m', spec.modelPath]
  if (upstream.mmprojPath) argv.push('--mmproj', upstream.mmprojPath)
  if (spec.modelId) argv.push('-a', spec.modelId)
  const ctx = String(upstream.ctxSize)
  argv.push('-c', ctx, '-b', ctx)
  if (upstream.wholePromptUbatch) argv.push('-ub', ctx)
  argv.push('-t', String(spec.threads))
  argv.push('--host', DECISION_HOST, '--port', String(spec.port))
  argv.push('--no-webui')
  return argv
}

/** The variables the core adds to the inherited environment. */
export function decisionEnv(apiKey: string): Record<string, string> {
  return { [DECISION_API_KEY_ENV]: apiKey }
}

/** The engine reads its `--decision-*` flags from these variables too (DECISION.md, Flags). */
export const DECISION_ENV_PREFIX = 'LLAMA_ARG_DECISION_'

/**
 * The inherited environment without `LLAMA_ARG_DECISION_*`: a stray `LLAMA_ARG_DECISION_DEBUG` in the
 * owner's environment would turn on request logging and raw logits, and `…_QUEUE` or `…_PLAN` would
 * change what the core asked for. The core states every decision flag it wants in argv. Matched
 * without case, as Windows names are.
 */
export function withoutDecisionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(env))
    if (!name.toUpperCase().startsWith(DECISION_ENV_PREFIX)) out[name] = value
  return out
}

export interface ThreadFacts {
  /** `settings.decision.threads`; 0 = automatic. */
  setting: number
  /** Physical cores (`SystemInfo.cpu.core_count`). */
  physicalCores: number
  /** Performance cores, when the hardware facts know them. */
  performanceCores?: number
  /**
   * A hybrid CPU whose performance-core count is unknown. Apple silicon counts its efficiency cores
   * as physical cores; ggml threads that land there hold every other thread up, so half the physical
   * count (the P-cores on the base M1–M3 parts) is the safe guess.
   */
  hybrid?: boolean
}

/** `-t`: the setting when given, else the performance cores (or a guess at them), 1 … `MAX_AUTO_THREADS`. */
export function decisionThreads(facts: ThreadFacts): number {
  if (Number.isInteger(facts.setting) && facts.setting > 0) return facts.setting
  const physical = Number.isInteger(facts.physicalCores) && facts.physicalCores > 0 ? facts.physicalCores : 1
  let auto = physical
  if (facts.performanceCores !== undefined && facts.performanceCores > 0) auto = facts.performanceCores
  else if (facts.hybrid) auto = Math.ceil(physical / 2)
  return Math.max(1, Math.min(MAX_AUTO_THREADS, auto))
}

/** The argv as the log shows it: the model path kept (it is not a secret), nothing else to hide. */
export function commandSummary(exe: string, argv: readonly string[]): string {
  return [exe, ...argv].map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(' ')
}
