/**
 * Driving image generation on the compiled binary: an owned engine tree whose `sd-server` is the
 * fake, model files, the control calls of the app's sequence (config → finalize → load), the job
 * poll, the process journal and a structured reader of the control event stream.
 *
 * Nothing here imports from `src/` (see `compiled-core.ts`): the engine tree is written by hand with
 * the marker and record names the core reads, so a packaging change cannot pass by type-checking.
 * POSIX only: the launchers are `#!/bin/sh` scripts.
 */
import type { ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import * as core from './compiled-core.js'
import type { ReadyLine } from './compiled-core.js'

export const FAKE_SD = fileURLToPath(new URL('./fake-sd-server.mjs', import.meta.url))
/** The build app v2.0.40 shipped: too old for Qwen Image 2.1 and Krea 2 Turbo. */
export const OLD_TAG = 'master-849-d04e895'
/** The build app v2.0.42 ships, the oldest that runs the modern families. */
export const NEW_TAG = 'master-883-137f740'
export const BACKEND_ID = 'fake-cpu'
/** Slow enough that the runner's 400 ms poll sees the steps, fast enough for a test. */
export const STEP_MS = '150'

/** One test's data folder, its daemons and the streams it opened; `sdCleanup` takes it all down. */
export interface SdContext {
  dataFolder: string
  pidFile: string
  daemons: ChildProcess[]
  streams: AbortController[]
}

export async function sdContext(prefix: string): Promise<SdContext> {
  const dataFolder = await mkdtemp(join(tmpdir(), prefix))
  return { dataFolder, pidFile: join(dataFolder, 'sd-pids'), daemons: [], streams: [] }
}

/** SIGKILL the daemons, reap what they journalled and every fake the pid file names, drop the folder. */
export async function sdCleanup(ctx: SdContext): Promise<void> {
  for (const stream of ctx.streams.splice(0)) stream.abort()
  for (const daemon of ctx.daemons.splice(0)) daemon.kill('SIGKILL')
  core.reapJournalledChildren(ctx.dataFolder)
  for (const pid of startedPids(ctx.pidFile)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  await rm(ctx.dataFolder, { recursive: true, force: true })
}

export const control = (ctx: SdContext, ready: ReadyLine, path: string, init: RequestInit = {}) =>
  core.control(ctx.dataFolder, ready, path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })

/** The parsed body of a 200; anything else fails the test with the body as the message. */
export async function json<T>(res: Response): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(200)
  return (await res.json()) as T
}

/** Every pid the fake appended: each process it ever started, in order. */
export function startedPids(pidFile: string): number[] {
  try {
    return readFileSync(pidFile, 'utf8').split('\n').filter(Boolean).map(Number)
  } catch {
    return []
  }
}

export interface JournalEntry {
  pid: number
  provider: string
  model_id: string
}

export function journalled(ctx: SdContext): JournalEntry[] {
  try {
    const journal = JSON.parse(
      readFileSync(join(ctx.dataFolder, 'atomic-core', 'processes.json'), 'utf8')
    ) as { processes?: JournalEntry[] }
    return journal.processes ?? []
  } catch {
    return []
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 20_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
}

export interface EngineOptions {
  tag?: string
  backendId?: string
  /** `FAKE_SD_*` exported to the fake; the pid file and the step pace are set unless overridden. */
  env?: Record<string, string>
}

/**
 * An engine tree under `<data>/diffusion/backends/<tag>/<backendId>/` whose `sd-server` and `sd-cli`
 * launch the fake with `env` baked in. Not yet owned: `finalizeEngine` writes the marker and record
 * the way the app's install does. Rewriting the launchers of a finalized tree changes what the next
 * spawn runs, so one daemon can play several modes.
 */
export async function writeSdEngine(ctx: SdContext, options: EngineOptions = {}): Promise<string> {
  const dir = join(
    ctx.dataFolder,
    'diffusion',
    'backends',
    options.tag ?? OLD_TAG,
    options.backendId ?? BACKEND_ID
  )
  await mkdir(dir, { recursive: true })
  const exports = Object.entries({ FAKE_SD_PID_FILE: ctx.pidFile, FAKE_SD_STEP_MS: STEP_MS, ...options.env })
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join('\n')
  for (const name of ['sd-server', 'sd-cli']) {
    await writeFile(
      join(dir, name),
      `#!/bin/sh\n${exports}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_SD)} "$@"\n`
    )
    await chmod(join(dir, name), 0o755)
  }
  return dir
}

/** A file under `<data>/diffusion/models/`; the fake never reads it. */
export async function writeSdFile(
  ctx: SdContext,
  relative = 'z-image/z-image-turbo-Q4_K_M.gguf'
): Promise<string> {
  const path = join(ctx.dataFolder, 'diffusion', 'models', ...relative.split('/'))
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, 'GGUF fake')
  return path
}

export interface LoadFiles {
  diffusionModel: string
  vae?: string
  clipL?: string
  t5xxl?: string
  llm?: string
  llmVision?: string
  qwen2vl?: string
}

/** The app's load request for a Z-Image quant, with `overrides` on top (a family, other files, …). */
export const sdLoadRequest = (files: LoadFiles, overrides: Record<string, unknown> = {}) => ({
  modelId: 'z-image:q4_k_m',
  family: 'z-image',
  modality: 'image',
  displayName: 'Z-Image Turbo',
  files,
  defaults: { steps: 4, cfgScale: 1, width: 256, height: 256 },
  ranges: { steps: [1, 50], dims: [256, 2048], dimMultiple: 16 },
  offload: 'none',
  startupTimeoutSecs: 30,
  ...overrides,
})

/** A generation request the fake completes in a few polls, with `overrides` on top. */
export const sdGenerateRequest = (overrides: Record<string, unknown> = {}) => ({
  prompt: 'a cat',
  width: 256,
  height: 256,
  steps: 4,
  cfgScale: 1,
  batchSize: 1,
  ...overrides,
})

export interface Job {
  id: string
  state: string
  progress: { phase: string; step: number; totalSteps: number; batchIndex: number } | null
  outputs: Array<{
    id: string
    path: string
    thumbnailPath: string | null
    width: number
    height: number
    recipe: { seed: number; engine: { cpuFallback: boolean; tag: string } }
  }>
  error?: { code: string; message: string; details?: string }
}

export const sdJob = async (ctx: SdContext, ready: ReadyLine, id: string): Promise<Job | null> =>
  (await json<{ job: Job | null }>(await control(ctx, ready, `/diffusion/jobs/${id}`))).job

/** Submit a job and wait for it to end; answers the record. */
export async function runJob(
  ctx: SdContext,
  ready: ReadyLine,
  request: Record<string, unknown> = {},
  timeoutMs = 30_000
): Promise<Job> {
  const { jobId } = await json<{ jobId: string }>(
    await control(ctx, ready, '/diffusion/jobs', {
      method: 'POST',
      body: JSON.stringify(sdGenerateRequest(request)),
    })
  )
  await waitFor(
    async () => ['completed', 'failed', 'cancelled'].includes((await sdJob(ctx, ready, jobId))?.state ?? ''),
    `job ${jobId} to end`,
    timeoutMs
  )
  return (await sdJob(ctx, ready, jobId)) as Job
}

export interface Status {
  configured: boolean
  install: { state: string; tag?: string; backendId?: string; dir?: string }
  model: {
    state: string
    loaded: { pid: number; cpuFallback: boolean } | null
    error?: { code: string; message: string; details?: string }
  }
  activeJob: { id: string } | null
  outputDir: string
  idleUnloadSecs: number
}

export const sdStatus = async (ctx: SdContext, ready: ReadyLine): Promise<Status> =>
  json<Status>(await control(ctx, ready, '/diffusion/status'))

/** `PUT /diffusion/config` on a fresh owner; answers the status. */
export async function configure(ctx: SdContext, ready: ReadyLine, extra: Record<string, unknown> = {}) {
  return json<Status>(
    await control(ctx, ready, '/diffusion/config', {
      method: 'PUT',
      body: JSON.stringify({ dataFolder: ctx.dataFolder, ...extra }),
    })
  )
}

export interface FinalizeOptions {
  tag?: string
  backendId?: string
  backend?: string
}

/** `POST /diffusion/backends/finalize` on `dir`, the way the app's installer ends an install. */
export async function finalizeEngine(
  ctx: SdContext,
  ready: ReadyLine,
  dir: string,
  options: FinalizeOptions = {}
): Promise<{ dir: string; tag: string; backendId: string; backend: string }> {
  return json(
    await control(ctx, ready, '/diffusion/backends/finalize', {
      method: 'POST',
      body: JSON.stringify({
        dir,
        tag: options.tag ?? OLD_TAG,
        backendId: options.backendId ?? BACKEND_ID,
        backend: options.backend ?? 'cpu',
        engine: 'sd-cpp',
      }),
    })
  )
}

export interface OwnerOptions extends EngineOptions {
  backend?: string
  /** Files named by the load beyond the transformer, as relative model paths. */
  files?: Omit<LoadFiles, 'diffusionModel'>
  load?: Record<string, unknown>
}

/**
 * Set up an owner with an engine finalized and a model loaded, the app's own sequence over the
 * control API; answers the ready line, the engine directory, the pid and the model file.
 */
export async function loadedOwner(ctx: SdContext, options: OwnerOptions = {}) {
  const dir = await writeSdEngine(ctx, options)
  const modelFile = await writeSdFile(ctx)
  const { ready } = await core.startDaemon(ctx.dataFolder, ctx.daemons)
  const configured = await configure(ctx, ready)
  expect(configured).toMatchObject({ configured: true, install: { state: 'not-installed' } })
  const record = await finalizeEngine(ctx, ready, dir, options)
  expect(record.dir).toBe(dir)
  const request = sdLoadRequest({ diffusionModel: modelFile, ...options.files }, options.load)
  const loaded = await json<{ pid: number; modelId: string }>(
    await control(ctx, ready, '/diffusion/model/load', { method: 'POST', body: JSON.stringify(request) })
  )
  expect(loaded.modelId).toBe(request.modelId)
  expect(alive(loaded.pid)).toBe(true)
  return { ready, dir, pid: loaded.pid, modelFile }
}

export interface StreamEvent {
  event: string
  data: Record<string, unknown>
}

/**
 * Every event of the control stream from now on, parsed. The stream is aborted by `sdCleanup`.
 * Open it before the action whose events are wanted: without a cursor the stream starts at "now".
 */
export async function collectEvents(ctx: SdContext, ready: ReadyLine): Promise<StreamEvent[]> {
  const controller = new AbortController()
  ctx.streams.push(controller)
  const res = await core.control(ctx.dataFolder, ready, '/events', { signal: controller.signal })
  const seen: StreamEvent[] = []
  void (async () => {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let pending = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        pending += decoder.decode(value, { stream: true })
        const frames = pending.split('\n\n')
        pending = frames.pop() ?? ''
        for (const frame of frames) {
          const event = /^event: (.*)$/m.exec(frame)?.[1]
          const data = /^data: (.*)$/m.exec(frame)?.[1]
          if (event && data) seen.push({ event, data: JSON.parse(data) as Record<string, unknown> })
        }
      }
    } catch {
      // Aborted at the end of the test.
    }
  })()
  return seen
}

/** The reasons of every `diffusion:state` event seen so far, in order. */
export const stateReasons = (events: readonly StreamEvent[]): string[] =>
  events.filter((e) => e.event === 'diffusion:state').map((e) => String(e.data['reason']))

/** The argv the fake was last started with (`FAKE_SD_ARGV_FILE`). */
export const sdArgv = (file: string): string[] => JSON.parse(readFileSync(file, 'utf8')) as string[]
