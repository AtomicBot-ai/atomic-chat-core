import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startControlHarness as start } from '../../../../test/helpers/control-harness.js'
import type { ControlHarness } from '../../../../test/helpers/control-harness.js'
import {
  FAKE_CAPABILITIES,
  FAKE_DIFFUSION_STATUS,
  FAKE_GALLERY_ITEM,
  FAKE_INSTALL_RECORD,
  FAKE_JOB,
  FAKE_LOADED_MODEL,
} from '../../../../test/helpers/fake-diffusion-control.js'
import { MAX_GENERATE_BODY_BYTES } from './diffusion.js'

let h: ControlHarness

beforeEach(async () => {
  h = await start()
})
afterEach(() => h.server.close())

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
})
const diffusionCalls = () => h.calls.filter((c) => c.startsWith('diffusion '))
type ErrorBody = { error: { code: string; message: string; details?: string } }
type Loose = Record<string, unknown>

describe('configuration and status', () => {
  it('configures, answers the status, and moves the output folder', async () => {
    const configured = await h.get(
      '/atomic/v1/diffusion/config',
      json({ dataFolder: '/tmp/data', outputDir: '/pics' }, 'PUT')
    )
    expect(configured.status).toBe(200)
    expect(await configured.json()).toEqual({ ...FAKE_DIFFUSION_STATUS, outputDir: '/pics' })
    expect(await (await h.get('/atomic/v1/diffusion/status')).json()).toEqual(FAKE_DIFFUSION_STATUS)
    const moved = await h.get('/atomic/v1/diffusion/output-dir', json({ path: '/elsewhere' }, 'PUT'))
    expect(((await moved.json()) as Loose)['outputDir']).toBe('/elsewhere')
    expect(diffusionCalls()).toEqual([
      'diffusion configure {"dataFolder":"/tmp/data","outputDir":"/pics"}',
      'diffusion setOutputDir /elsewhere',
    ])
  })

  it('refuses a body that is not the contract, with the diffusion code', async () => {
    const res = await h.get('/atomic/v1/diffusion/config', json({}, 'PUT'))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: {
        code: 'INVALID_REQUEST',
        message: 'The request is not valid.',
        details: 'dataFolder: expected a string',
      },
    })
    expect(diffusionCalls()).toEqual([])
  })
})

describe('the engine and the model files', () => {
  it('finalizes, lists and removes engine trees', async () => {
    const args = { dir: '/d', tag: 't', backendId: 'cpu', backend: 'cpu', engine: 'sd-cpp', sha256: 'ff' }
    const finalized = await h.get('/atomic/v1/diffusion/backends/finalize', json(args))
    expect(await finalized.json()).toEqual({
      ...FAKE_INSTALL_RECORD,
      dir: '/d',
      tag: 't',
      backendId: 'cpu',
      sha256: 'ff',
    })
    expect(await (await h.get('/atomic/v1/diffusion/backends')).json()).toEqual({
      backends: [FAKE_INSTALL_RECORD],
    })
    const removed = await h.get('/atomic/v1/diffusion/backends/remove', json({ dir: '/d' }))
    expect(removed.status).toBe(200)
    expect(await removed.json()).toEqual({})
    expect((await h.get('/atomic/v1/diffusion/backends/finalize', json({ dir: '/d' }))).status).toBe(400)
    expect(diffusionCalls()).toEqual([
      `diffusion finalize ${JSON.stringify(args)}`,
      'diffusion removeBackend /d',
    ])
  })

  it('lists and deletes model files', async () => {
    expect(await (await h.get('/atomic/v1/diffusion/model-files')).json()).toEqual({
      files: [
        { path: '/tmp/data/diffusion/models/z-image/z.gguf', relativePath: 'z-image/z.gguf', bytes: 5 },
      ],
    })
    expect(
      await (await h.get('/atomic/v1/diffusion/model-files/delete', json({ path: '/m/z.gguf' }))).json()
    ).toEqual({})
    expect((await h.get('/atomic/v1/diffusion/model-files/delete', json({}))).status).toBe(400)
    expect(diffusionCalls()).toEqual(['diffusion deleteModelFile /m/z.gguf'])
  })
})

describe('the session', () => {
  it('loads, unloads, answers capabilities and touches the idle timer', async () => {
    const request = {
      modelId: 'flux.2-klein:q4_k_m',
      family: 'flux.2-klein',
      modality: 'image',
      displayName: 'FLUX.2 Klein',
      files: { diffusionModel: '/m/klein.gguf' },
      defaults: { steps: 4, cfgScale: 1, width: 1024, height: 1024 },
      ranges: { steps: [1, 50], dims: [256, 2048], dimMultiple: 16 },
      offload: 'group',
    }
    const loaded = await h.get('/atomic/v1/diffusion/model/load', json(request))
    expect(loaded.status).toBe(200)
    expect(await loaded.json()).toEqual({ ...FAKE_LOADED_MODEL, modelId: 'flux.2-klein:q4_k_m' })
    expect(await (await h.get('/atomic/v1/diffusion/capabilities')).json()).toEqual(FAKE_CAPABILITIES)
    expect(await (await h.get('/atomic/v1/diffusion/idle/touch', { method: 'POST' })).json()).toEqual({})
    expect(await (await h.get('/atomic/v1/diffusion/model/unload', { method: 'POST' })).json()).toEqual({})
    const bad = await h.get('/atomic/v1/diffusion/model/load', json({ ...request, offload: 'all' }))
    expect(bad.status).toBe(400)
    expect(diffusionCalls()).toEqual([
      'diffusion loadModel flux.2-klein:q4_k_m',
      'diffusion touchIdle',
      'diffusion unloadModel',
    ])
  })
})

describe('jobs', () => {
  it('starts a job, reads it back (or null), and cancels it', async () => {
    const request = { prompt: 'a cat', width: 512, height: 768, steps: 8, cfgScale: 1, batchSize: 2 }
    const started = await h.get('/atomic/v1/diffusion/jobs', json(request))
    expect(started.status).toBe(200)
    expect(await started.json()).toEqual({ jobId: FAKE_JOB.id })
    expect(await (await h.get(`/atomic/v1/diffusion/jobs/${FAKE_JOB.id}`)).json()).toEqual({ job: FAKE_JOB })
    expect(await (await h.get('/atomic/v1/diffusion/jobs/unknown')).json()).toEqual({ job: null })
    expect(
      await (await h.get(`/atomic/v1/diffusion/jobs/${FAKE_JOB.id}/cancel`, { method: 'POST' })).json()
    ).toEqual({
      cancelled: true,
      serverStopped: false,
    })
    expect((await h.get('/atomic/v1/diffusion/jobs', json({ ...request, steps: 1.5 }))).status).toBe(400)
    expect(diffusionCalls()).toEqual([
      'diffusion generate a cat 512x768',
      `diffusion cancelJob ${FAKE_JOB.id}`,
    ])
  })

  it('takes a generation body far larger than the control default, for inline images', async () => {
    expect(MAX_GENERATE_BODY_BYTES).toBe(64 * 1024 * 1024)
    const big = 'A'.repeat(9 * 1024 * 1024)
    const res = await h.get(
      '/atomic/v1/diffusion/jobs',
      json({
        prompt: 'a cat',
        width: 512,
        height: 512,
        steps: 8,
        cfgScale: 1,
        batchSize: 1,
        initImage: { base64: big },
      })
    )
    expect(res.status).toBe(200)
    // Everywhere else the general cap holds.
    const refused = await h.get('/atomic/v1/diffusion/config', json({ dataFolder: big }, 'PUT'))
    expect(refused.status).toBe(400)
    expect(((await refused.json()) as ErrorBody).error.message).toBe('Request body is too large.')
  })
})

describe('the gallery', () => {
  it('lists with query options, reads one item (or null), flags, exports and deletes', async () => {
    const page = await h.get('/atomic/v1/diffusion/gallery?offset=20&limit=40&includeArchived=true')
    expect(page.status).toBe(200)
    expect(await page.json()).toEqual({ items: [FAKE_GALLERY_ITEM], hasMore: false, total: 1 })
    await h.get('/atomic/v1/diffusion/gallery?offset=0&limit=10')
    const missing = await h.get('/atomic/v1/diffusion/gallery?limit=10')
    expect(missing.status).toBe(400)
    expect(((await missing.json()) as ErrorBody).error.details).toBe(
      'offset: expected a whole number, zero or more'
    )

    expect(await (await h.get(`/atomic/v1/diffusion/gallery/${FAKE_GALLERY_ITEM.id}`)).json()).toEqual({
      item: FAKE_GALLERY_ITEM,
    })
    expect(await (await h.get('/atomic/v1/diffusion/gallery/nope')).json()).toEqual({ item: null })
    const flagged = await h.get(
      `/atomic/v1/diffusion/gallery/${FAKE_GALLERY_ITEM.id}/flags`,
      json({ pinned: true }, 'PATCH')
    )
    expect(((await flagged.json()) as Loose)['pinned']).toBe(true)
    expect(
      (
        await h.get(
          `/atomic/v1/diffusion/gallery/${FAKE_GALLERY_ITEM.id}/flags`,
          json({ pinned: 'yes' }, 'PATCH')
        )
      ).status
    ).toBe(400)
    expect(
      await (
        await h.get(
          `/atomic/v1/diffusion/gallery/${FAKE_GALLERY_ITEM.id}/export`,
          json({ targetPath: '/out/a.png' })
        )
      ).json()
    ).toEqual({})
    expect(
      await (
        await h.get('/atomic/v1/diffusion/gallery/delete', json({ ids: [FAKE_GALLERY_ITEM.id, 'other'] }))
      ).json()
    ).toEqual({})
    expect((await h.get('/atomic/v1/diffusion/gallery/delete', json({ ids: 'x' }))).status).toBe(400)
    expect(diffusionCalls()).toEqual([
      'diffusion listGallery {"offset":20,"limit":40,"includeArchived":true}',
      'diffusion listGallery {"offset":0,"limit":10}',
      `diffusion setGalleryFlags ${FAKE_GALLERY_ITEM.id} {"pinned":true}`,
      `diffusion exportGalleryItem ${FAKE_GALLERY_ITEM.id} /out/a.png`,
      `diffusion deleteGalleryItems ${FAKE_GALLERY_ITEM.id},other`,
    ])
  })
})

describe('the wire', () => {
  it('requires the token and answers 404 for what is not a route', async () => {
    expect(
      (await h.get('/atomic/v1/diffusion/status', { headers: { authorization: 'Bearer nope' } })).status
    ).toBe(401)
    expect((await h.get('/atomic/v1/diffusion/nothing')).status).toBe(404)
    expect((await h.get('/atomic/v1/diffusion/status', { method: 'DELETE' })).status).toBe(405)
  })
})
