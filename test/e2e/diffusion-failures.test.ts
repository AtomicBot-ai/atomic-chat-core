/**
 * When the image engine misbehaves, through the compiled binary (app v2.0.42, stage 7l): a blank
 * frame refused with nothing saved and the engine left running; a GPU fault in the job's own output
 * retiring the server with the model kept, the next job respawning it; a ggml unsupported-op abort
 * retried once on the CPU backend.
 *
 * No imports from `src/`. POSIX only: the fake engine is a shell launcher.
 */
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as sd from '../helpers/compiled-diffusion.js'
import type { SdContext } from '../helpers/compiled-diffusion.js'
import * as core from '../helpers/compiled-core.js'

const { BIN } = core
const { alive, control, journalled, json, waitFor } = sd

let ctx: SdContext
beforeEach(async () => {
  ctx = await sd.sdContext('atomic-core-e2e-diffusion-failures-')
})
afterEach(() => sd.sdCleanup(ctx))

const imagesOnDisk = async () =>
  (await readdir(join(ctx.dataFolder, 'images')).catch(() => [])).filter(
    (name) => name.endsWith('.png') && !name.endsWith('.thumb.png')
  )

describe.skipIf(!existsSync(BIN) || process.platform === 'win32')('an image engine that misbehaves', () => {
  it('refuses a blank frame: INVALID_OUTPUT, nothing saved, the engine left running', async () => {
    const { ready, pid } = await sd.loadedOwner(ctx, { env: { FAKE_SD_BLANK_SEED: '13' } })
    const events = await sd.collectEvents(ctx, ready)
    const blank = await sd.runJob(ctx, ready, { seed: 13, batchSize: 2 })
    expect(blank.state).toBe('failed')
    expect(blank.error).toMatchObject({
      code: 'INVALID_OUTPUT',
      message: 'The image engine produced a blank frame. Nothing was saved.',
    })
    expect(blank.outputs).toEqual([])
    expect(
      (await json<{ total: number }>(await control(ctx, ready, '/diffusion/gallery?offset=0&limit=10'))).total
    ).toBe(0)
    expect(await imagesOnDisk()).toEqual([])
    await waitFor(
      () => events.some((e) => e.event === 'diffusion:error' && e.data['code'] === 'INVALID_OUTPUT'),
      'the error event'
    )
    // The engine did nothing wrong that a restart would fix: it stays up and serves the next seed.
    expect(alive(pid)).toBe(true)
    const status = await sd.sdStatus(ctx, ready)
    expect(status.model.state).toBe('loaded')
    expect(status.model.loaded?.pid).toBe(pid)
    const good = await sd.runJob(ctx, ready, { seed: 7 })
    expect(good.state).toBe('completed')
    expect(good.outputs).toHaveLength(1)
    expect(await imagesOnDisk()).toHaveLength(1)
    expect((await sd.sdStatus(ctx, ready)).model.loaded?.pid).toBe(pid)

    // The facade reports the same refusal in OpenAI's envelope.
    const started = await json<{ port: number }>(
      await control(ctx, ready, '/server/start', { method: 'POST', body: JSON.stringify({ port: 0 }) })
    )
    const refused = await fetch(`http://127.0.0.1:${started.port}/v1/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a cat', seed: 13 }),
    })
    expect(refused.status).toBe(500)
    expect(await refused.json()).toMatchObject({
      error: { code: 'server_error', message: 'The image engine produced a blank frame. Nothing was saved.' },
    })
    expect(await imagesOnDisk()).toHaveLength(1)
  }, 60_000)

  it("retires the engine after a GPU fault in the job's own output, keeps the model, and the next job respawns it", async () => {
    const { ready, pid } = await sd.loadedOwner(ctx, {
      env: { FAKE_SD_MODE: 'gpu-fault', FAKE_SD_ONCE_MARKER: join(ctx.dataFolder, 'faulted-once') },
    })
    const events = await sd.collectEvents(ctx, ready)
    const faulted = await sd.runJob(ctx, ready)
    expect(faulted.state).toBe('failed')
    expect(faulted.error?.code).toBe('ENGINE_CRASHED')
    expect(faulted.error?.message).toMatch(/^The GPU stopped this render\./)
    expect(faulted.error?.details).toContain('GPU Address Fault')
    await waitFor(() => sd.stateReasons(events).includes('gpu-fault'), 'the gpu-fault state event')
    // Metal stays broken after an address fault: the process is retired even though it is still up.
    await waitFor(() => !alive(pid), 'the faulted server to be stopped')
    expect(journalled(ctx)).toEqual([])
    const retired = await sd.sdStatus(ctx, ready)
    expect(retired.model.state).toBe('failed')
    expect(retired.model.error?.code).toBe('ENGINE_CRASHED')
    expect(retired.model.loaded).toBeNull()

    // The spec was kept: the next job brings a clean server up and completes.
    const next = await sd.runJob(ctx, ready)
    expect(next.state).toBe('completed')
    const respawned = await sd.sdStatus(ctx, ready)
    expect(respawned.model.state).toBe('loaded')
    expect(respawned.model.loaded?.pid).not.toBe(pid)
    expect(sd.startedPids(ctx.pidFile)).toEqual([pid, respawned.model.loaded?.pid])
    expect(journalled(ctx)).toEqual([
      expect.objectContaining({ provider: 'diffusion', pid: respawned.model.loaded?.pid }),
    ])
    expect(sd.stateReasons(events)).toContain('respawn')
  }, 60_000)

  it('retries a job once on the CPU backend after a ggml unsupported-op abort', async () => {
    const argvFile = join(ctx.dataFolder, 'sd-argv.json')
    const { ready, pid } = await sd.loadedOwner(ctx, {
      env: { FAKE_SD_MODE: 'ggml-abort', FAKE_SD_ARGV_FILE: argvFile },
    })
    expect(sd.sdArgv(argvFile)).not.toContain('--backend')
    const events = await sd.collectEvents(ctx, ready)
    const job = await sd.runJob(ctx, ready)
    expect(job.state).toBe('completed')
    expect(job.outputs).toHaveLength(1)
    expect(job.outputs[0]?.recipe.engine.cpuFallback).toBe(true)

    // The device process aborted and a second one ran the job on `--backend cpu`, last in the argv.
    const pids = sd.startedPids(ctx.pidFile)
    expect(pids).toHaveLength(2)
    expect(pids[0]).toBe(pid)
    expect(alive(pid)).toBe(false)
    const argv = sd.sdArgv(argvFile)
    expect(argv.slice(-2)).toEqual(['--backend', 'cpu'])
    const status = await sd.sdStatus(ctx, ready)
    expect(status.model.state).toBe('loaded')
    expect(status.model.loaded).toMatchObject({ pid: pids[1], cpuFallback: true })
    expect(journalled(ctx)).toEqual([expect.objectContaining({ provider: 'diffusion', pid: pids[1] })])
    expect(sd.stateReasons(events)).toContain('cpu-fallback')
    expect(events.some((e) => e.event === 'diffusion:error')).toBe(false)
  }, 60_000)
})
