/**
 * Stage 7: image generation through the compiled binary, against the fake `sd-server`. What is
 * asserted is what the app sees and what the machine is left with: the control routes answer in
 * the app's shapes, the events arrive over SSE, the PNG and its thumbnail land in the gallery, the
 * OpenAI facade serves the same job, a cancel that the engine ignores stops the process and the next
 * job brings it back, an unload leaves no journal entry, and a crashed core's successor reaps the
 * orphan.
 *
 * No imports from `src/`: a packaging change that breaks a route cannot pass by type-checking.
 */
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as core from '../helpers/compiled-core.js'
import type { ReadyLine } from '../helpers/compiled-core.js'
import { FAKE_SD_SCRIPT } from '../helpers/fake-sd-server.js'

const { BIN } = core

let dataFolder: string
let pidFile: string
const daemons: ChildProcess[] = []

beforeEach(async () => {
  dataFolder = await mkdtemp(join(tmpdir(), 'atomic-core-e2e-diffusion-'))
  pidFile = join(dataFolder, 'sd-pids')
})
afterEach(async () => {
  for (const daemon of daemons.splice(0)) daemon.kill('SIGKILL')
  core.reapJournalledChildren(dataFolder)
  for (const pid of startedPids()) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  await rm(dataFolder, { recursive: true, force: true })
})

const control = (ready: ReadyLine, path: string, init: RequestInit = {}) =>
  core.control(dataFolder, ready, path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
const json = async <T>(res: Response): Promise<T> => {
  expect(res.status, await res.clone().text()).toBe(200)
  return (await res.json()) as T
}

function startedPids(): number[] {
  try {
    return readFileSync(pidFile, 'utf8').split('\n').filter(Boolean).map(Number)
  } catch {
    return []
  }
}

function journalled(): Array<{ pid: number; provider: string; model_id: string }> {
  try {
    const journal = JSON.parse(readFileSync(join(dataFolder, 'atomic-core', 'processes.json'), 'utf8')) as {
      processes?: Array<{ pid: number; provider: string; model_id: string }>
    }
    return journal.processes ?? []
  } catch {
    return []
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(
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

/** An engine tree whose `sd-server` and `sd-cli` launch the fake with `env` baked in. */
async function writeEngine(env: Record<string, string>): Promise<string> {
  const dir = join(dataFolder, 'diffusion', 'backends', 'master-849-d04e895', 'fake-cpu')
  await mkdir(dir, { recursive: true })
  const exports = Object.entries({ FAKE_SD_PID_FILE: pidFile, ...env })
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join('\n')
  for (const name of ['sd-server', 'sd-cli']) {
    await writeFile(
      join(dir, name),
      `#!/bin/sh\n${exports}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_SD_SCRIPT)} "$@"\n`
    )
    await chmod(join(dir, name), 0o755)
  }
  return dir
}

async function writeModelFile(): Promise<string> {
  const path = join(dataFolder, 'diffusion', 'models', 'z-image', 'z-image-turbo-Q4_K_M.gguf')
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, 'GGUF fake')
  return path
}

const loadRequest = (diffusionModel: string) => ({
  modelId: 'z-image:q4_k_m',
  family: 'z-image',
  modality: 'image',
  displayName: 'Z-Image Turbo',
  files: { diffusionModel },
  defaults: { steps: 4, cfgScale: 1, width: 256, height: 256 },
  ranges: { steps: [1, 50], dims: [256, 2048], dimMultiple: 16 },
  offload: 'none',
  startupTimeoutSecs: 30,
})

interface Job {
  id: string
  state: string
  progress: { phase: string; step: number; totalSteps: number; batchIndex: number } | null
  outputs: Array<{
    id: string
    path: string
    thumbnailPath: string | null
    width: number
    height: number
    recipe: { seed: number }
  }>
  error?: { code: string; message: string }
}

const job = async (ready: ReadyLine, id: string): Promise<Job | null> =>
  (await json<{ job: Job | null }>(await control(ready, `/diffusion/jobs/${id}`))).job

/** Set up an owner with an engine finalized and a model loaded; answers the ready line and the pid. */
async function loadedOwner(env: Record<string, string> = {}) {
  // Slow enough that the runner's 400 ms poll sees the steps, fast enough for a test.
  const dir = await writeEngine({ FAKE_SD_STEP_MS: '150', ...env })
  const modelFile = await writeModelFile()
  const { ready } = await core.startDaemon(dataFolder, daemons)
  const configured = await json<{ configured: boolean; install: { state: string } }>(
    await control(ready, '/diffusion/config', { method: 'PUT', body: JSON.stringify({ dataFolder }) })
  )
  expect(configured).toMatchObject({ configured: true, install: { state: 'not-installed' } })
  const record = await json<{ dir: string }>(
    await control(ready, '/diffusion/backends/finalize', {
      method: 'POST',
      body: JSON.stringify({
        dir,
        tag: 'master-849-d04e895',
        backendId: 'fake-cpu',
        backend: 'cpu',
        engine: 'sd-cpp',
      }),
    })
  )
  expect(record.dir).toBe(dir)
  const loaded = await json<{ pid: number; modelId: string }>(
    await control(ready, '/diffusion/model/load', {
      method: 'POST',
      body: JSON.stringify(loadRequest(modelFile)),
    })
  )
  expect(loaded.modelId).toBe('z-image:q4_k_m')
  expect(alive(loaded.pid)).toBe(true)
  return { ready, dir, pid: loaded.pid }
}

describe.skipIf(!existsSync(BIN) || process.platform === 'win32')(
  'image generation on the compiled core',
  () => {
    it('finalizes, loads, generates with events, fills the gallery and serves the OpenAI facade', async () => {
      const { ready, pid } = await loadedOwner()
      expect(journalled()).toEqual([
        expect.objectContaining({ pid, provider: 'diffusion', model_id: 'z-image:q4_k_m' }),
      ])
      const status = await json<{
        model: { state: string; loaded: { pid: number } | null }
        install: { backendId: string }
      }>(await control(ready, '/diffusion/status'))
      expect(status.model.state).toBe('loaded')
      expect(status.model.loaded?.pid).toBe(pid)
      expect(status.install.backendId).toBe('fake-cpu')
      const capabilities = await json<{ workflows: string[]; maxBatch: number }>(
        await control(ready, '/diffusion/capabilities')
      )
      expect(capabilities.maxBatch).toBe(4)
      expect(capabilities.workflows).toContain('inpaint')
      // The image model is not a chat session.
      expect((await json<{ sessions: unknown[] }>(await control(ready, '/sessions'))).sessions).toEqual([])

      const snapshot = await json<{ cursor: string }>(await control(ready, '/snapshot'))
      const stream = await control(ready, `/events?cursor=${encodeURIComponent(snapshot.cursor)}`)
      const reader = stream.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>
      let seen = ''
      const pump = (async () => {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) return
          seen += new TextDecoder().decode(value)
        }
      })()

      const { jobId } = await json<{ jobId: string }>(
        await control(ready, '/diffusion/jobs', {
          method: 'POST',
          body: JSON.stringify({
            prompt: 'a cat',
            width: 256,
            height: 256,
            steps: 4,
            cfgScale: 1,
            batchSize: 2,
            seed: 7,
          }),
        })
      )
      const busy = await control(ready, '/diffusion/jobs', {
        method: 'POST',
        body: JSON.stringify({
          prompt: 'another',
          width: 256,
          height: 256,
          steps: 4,
          cfgScale: 1,
          batchSize: 1,
        }),
      })
      expect(busy.status).toBe(409)
      expect(await busy.json()).toMatchObject({ error: { code: 'JOB_BUSY', details: jobId } })

      await waitFor(async () => (await job(ready, jobId))?.state === 'completed', 'the job to complete')
      const done = (await job(ready, jobId)) as Job
      expect(done.outputs).toHaveLength(2)
      expect(done.outputs.map((o) => o.recipe.seed)).toEqual([7, 8])
      expect(done.progress).toMatchObject({ phase: 'saving', totalSteps: 4 })
      for (const output of done.outputs) {
        expect(output.path.startsWith(join(dataFolder, 'images'))).toBe(true)
        expect(existsSync(output.path)).toBe(true)
        expect(output.thumbnailPath).not.toBeNull()
        expect(existsSync(output.thumbnailPath as string)).toBe(true)
        const png = await readFile(output.path)
        expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        expect(png.indexOf('tEXtatomic\0{"jobId":"')).toBeGreaterThan(0)
        expect(png.indexOf('tEXtparameters\0a cat\n')).toBeGreaterThan(0)
      }
      await waitFor(() => seen.includes('"state":"completed"'), 'the completed job event')
      await reader.cancel()
      await pump.catch(() => undefined)
      expect(seen).toContain('event: diffusion:job')
      expect(seen).toContain('event: diffusion:progress')
      expect(seen).toMatch(/"phase":"sampling"/)
      expect(seen).not.toContain('event: diffusion:error')

      const page = await json<{ total: number; items: Array<{ id: string; pinned: boolean }> }>(
        await control(ready, '/diffusion/gallery?offset=0&limit=10')
      )
      expect(page.total).toBe(2)
      const first = page.items[0] as { id: string }
      const flagged = await json<{ pinned: boolean }>(
        await control(ready, `/diffusion/gallery/${first.id}/flags`, {
          method: 'PATCH',
          body: JSON.stringify({ pinned: true }),
        })
      )
      expect(flagged.pinned).toBe(true)
      expect(JSON.parse(await readFile(join(dataFolder, 'images', '.flags.json'), 'utf8'))).toEqual({
        [first.id]: { pinned: true, archived: false },
      })
      const exported = join(dataFolder, 'exported.png')
      await json(
        await control(ready, `/diffusion/gallery/${first.id}/export`, {
          method: 'POST',
          body: JSON.stringify({ targetPath: exported }),
        })
      )
      expect(existsSync(exported)).toBe(true)

      // The OpenAI facade on the public listener runs the same job and answers with the bytes.
      const started = await json<{ port: number }>(
        await control(ready, '/server/start', { method: 'POST', body: JSON.stringify({ port: 0 }) })
      )
      const base = `http://127.0.0.1:${started.port}/v1`
      const models = await (await fetch(`${base}/models`)).json()
      expect(JSON.stringify(models)).not.toContain('z-image')
      const generated = await fetch(`${base}/images/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'a cat', size: 'auto', n: 1, seed: 11, model: 'Z-Image Turbo' }),
      })
      expect(generated.status, await generated.clone().text()).toBe(200)
      const answer = (await generated.json()) as {
        data: Array<{ b64_json: string }>
        atomic: { seed: number; paths: string[] }
      }
      expect(Buffer.from(answer.data[0]?.b64_json ?? '', 'base64').subarray(0, 4)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47])
      )
      expect(answer.atomic.seed).toBe(11)
      expect(existsSync(answer.atomic.paths[0] as string)).toBe(true)
      const refused = await fetch(`${base}/images/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'a cat', model: 'gpt-image-1' }),
      })
      expect(refused.status).toBe(503)
      expect(await refused.json()).toMatchObject({ error: { code: 'model_not_loaded' } })

      // Unload: the process is gone and so is its journal entry.
      await json(await control(ready, '/diffusion/model/unload', { method: 'POST' }))
      expect(alive(pid)).toBe(false)
      expect(journalled()).toEqual([])
      expect(
        (await json<{ model: { state: string } }>(await control(ready, '/diffusion/status'))).model.state
      ).toBe('unloaded')
    }, 60_000)

    it('stops an engine that ignores a cancel, and the next job brings it back', async () => {
      const { ready, pid } = await loadedOwner({ FAKE_SD_STEP_MS: '400' })
      const { jobId } = await json<{ jobId: string }>(
        await control(ready, '/diffusion/jobs', {
          method: 'POST',
          body: JSON.stringify({
            prompt: 'a cat',
            width: 256,
            height: 256,
            // Forty steps at 400 ms: well past the 5 s grace a cancel gets before the process is stopped.
            steps: 40,
            cfgScale: 1,
            batchSize: 1,
          }),
        })
      )
      await waitFor(async () => (await job(ready, jobId))?.state === 'generating', 'the job to start')
      const cancelled = await json<{ cancelled: boolean; serverStopped: boolean }>(
        await control(ready, `/diffusion/jobs/${jobId}/cancel`, { method: 'POST' })
      )
      // The default grace is 5 s; the fake never honours a cancel, so the process is stopped.
      expect(cancelled).toEqual({ cancelled: true, serverStopped: true })
      expect(alive(pid)).toBe(false)
      expect((await job(ready, jobId))?.state).toBe('cancelled')
      expect(journalled()).toEqual([])
      const status = await json<{ model: { state: string } }>(await control(ready, '/diffusion/status'))
      expect(status.model.state).toBe('unloaded')

      const next = await json<{ jobId: string }>(
        await control(ready, '/diffusion/jobs', {
          method: 'POST',
          body: JSON.stringify({
            prompt: 'a cat',
            width: 256,
            height: 256,
            steps: 1,
            cfgScale: 1,
            batchSize: 1,
          }),
        })
      )
      await waitFor(
        async () => (await job(ready, next.jobId))?.state === 'completed',
        'the next job to complete',
        30_000
      )
      const respawned = await json<{ model: { state: string; loaded: { pid: number } | null } }>(
        await control(ready, '/diffusion/status')
      )
      expect(respawned.model.state).toBe('loaded')
      expect(respawned.model.loaded?.pid).not.toBe(pid)
      expect(journalled()).toEqual([
        expect.objectContaining({ provider: 'diffusion', pid: respawned.model.loaded?.pid }),
      ])
    }, 60_000)

    it("reaps a crashed owner's sd-server on the next start", async () => {
      const { ready, pid } = await loadedOwner()
      void ready
      for (const daemon of daemons.splice(0)) daemon.kill('SIGKILL')
      expect(alive(pid)).toBe(true)
      const { ready: next } = await core.startDaemon(dataFolder, daemons)
      await waitFor(() => !alive(pid), 'the orphan to be reaped')
      expect(journalled()).toEqual([])
      const status = await json<{ configured: boolean; model: { state: string } }>(
        await control(next, '/diffusion/status')
      )
      // A new generation has forgotten the configuration: the app sends it again on `snapshot`.
      expect(status).toMatchObject({ configured: false, model: { state: 'unloaded' } })
    }, 60_000)
  }
)
