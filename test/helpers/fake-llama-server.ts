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
  'ready' | 'no-ready' | 'hang' | 'oom' | 'segv' | 'projector-fail' | 'mtp-fail' | `exit-${number}`

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
}

function fakeEnv(options: FakeLlamaOptions): Record<string, string> {
  const env: Record<string, string> = { FAKE_LLAMA_MODE: options.mode ?? 'ready' }
  if (options.gpu) env['FAKE_LLAMA_GPU'] = '1'
  if (options.delayMs) env['FAKE_LLAMA_DELAY'] = String(options.delayMs)
  if (options.specTypes) env['FAKE_LLAMA_SPEC_TYPES'] = options.specTypes
  if (options.reply) env['FAKE_LLAMA_REPLY'] = options.reply
  if (options.minCtx) env['FAKE_LLAMA_MIN_CTX'] = String(options.minCtx)
  if (options.computeErrorMarker) env['FAKE_LLAMA_COMPUTE_ERROR_MARKER'] = options.computeErrorMarker
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
