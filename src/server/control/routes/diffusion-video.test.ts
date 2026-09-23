import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startControlHarness as start } from '../../../../test/helpers/control-harness.js'
import type { ControlHarness } from '../../../../test/helpers/control-harness.js'
import {
  FAKE_VIDEO_CAPABILITIES,
  FAKE_VIDEO_ITEM,
  FAKE_VIDEO_JOB,
} from '../../../../test/helpers/fake-diffusion-control.js'
import { MAX_POSTER_BODY_BYTES } from './diffusion-video.js'

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

describe('video capabilities and jobs', () => {
  it('answers the video capabilities, starts a job, reads it back (or null), and cancels it', async () => {
    expect(await (await h.get('/atomic/v1/diffusion/video/capabilities')).json()).toEqual(
      FAKE_VIDEO_CAPABILITIES
    )
    const request = { prompt: 'a cat walking', width: 768, height: 512, frames: 25, steps: 8, cfgScale: 1 }
    const started = await h.get('/atomic/v1/diffusion/video/jobs', json(request))
    expect(started.status).toBe(200)
    expect(await started.json()).toEqual({ jobId: FAKE_VIDEO_JOB.id })
    expect(await (await h.get(`/atomic/v1/diffusion/video/jobs/${FAKE_VIDEO_JOB.id}`)).json()).toEqual({
      job: FAKE_VIDEO_JOB,
    })
    expect(await (await h.get('/atomic/v1/diffusion/video/jobs/unknown')).json()).toEqual({ job: null })
    // The image lookup does not know a video job, and the other way round.
    expect(await (await h.get(`/atomic/v1/diffusion/jobs/${FAKE_VIDEO_JOB.id}`)).json()).toEqual({
      job: null,
    })
    expect(
      await (
        await h.get(`/atomic/v1/diffusion/video/jobs/${FAKE_VIDEO_JOB.id}/cancel`, { method: 'POST' })
      ).json()
    ).toEqual({ cancelled: true, serverStopped: false })
    const bad = await h.get('/atomic/v1/diffusion/video/jobs', json({ ...request, frames: 24.5 }))
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as ErrorBody).error.details).toBe(
      'frames: expected a whole number, zero or more'
    )
    expect(diffusionCalls()).toEqual([
      'diffusion generateVideo a cat walking 768x512x25',
      `diffusion cancelVideoJob ${FAKE_VIDEO_JOB.id}`,
    ])
  })
})

describe('the video gallery', () => {
  it('lists with query options, reads one item (or null), flags, exports, deletes and takes a poster', async () => {
    const page = await h.get('/atomic/v1/diffusion/video/gallery?offset=20&limit=40&includeArchived=true')
    expect(page.status).toBe(200)
    expect(await page.json()).toEqual({ items: [FAKE_VIDEO_ITEM], hasMore: false, total: 1 })
    const missing = await h.get('/atomic/v1/diffusion/video/gallery?limit=10')
    expect(missing.status).toBe(400)
    expect(((await missing.json()) as ErrorBody).error.details).toBe(
      'offset: expected a whole number, zero or more'
    )

    expect(await (await h.get(`/atomic/v1/diffusion/video/gallery/${FAKE_VIDEO_ITEM.id}`)).json()).toEqual({
      item: FAKE_VIDEO_ITEM,
    })
    expect(await (await h.get('/atomic/v1/diffusion/video/gallery/nope')).json()).toEqual({ item: null })
    const flagged = await h.get(
      `/atomic/v1/diffusion/video/gallery/${FAKE_VIDEO_ITEM.id}/flags`,
      json({ pinned: true }, 'PATCH')
    )
    expect(((await flagged.json()) as Loose)['pinned']).toBe(true)
    expect(
      (
        await h.get(
          `/atomic/v1/diffusion/video/gallery/${FAKE_VIDEO_ITEM.id}/flags`,
          json({ pinned: 'yes' }, 'PATCH')
        )
      ).status
    ).toBe(400)
    expect(
      await (
        await h.get(
          `/atomic/v1/diffusion/video/gallery/${FAKE_VIDEO_ITEM.id}/export`,
          json({ targetPath: '/out/a.webm' })
        )
      ).json()
    ).toEqual({})
    expect(
      await (
        await h.get('/atomic/v1/diffusion/video/gallery/delete', json({ ids: [FAKE_VIDEO_ITEM.id] }))
      ).json()
    ).toEqual({})
    expect((await h.get('/atomic/v1/diffusion/video/gallery/delete', json({ ids: 'x' }))).status).toBe(400)

    const poster = await h.get(
      `/atomic/v1/diffusion/video/gallery/${FAKE_VIDEO_ITEM.id}/poster`,
      json({ png: 'data:image/png;base64,iVBORw0KGgo=' }, 'PUT')
    )
    expect(poster.status).toBe(200)
    expect(((await poster.json()) as Loose)['posterPath']).toBe(
      `/tmp/data/videos/${FAKE_VIDEO_ITEM.id}.thumb.png`
    )
    const notPng = await h.get(
      `/atomic/v1/diffusion/video/gallery/${FAKE_VIDEO_ITEM.id}/poster`,
      json({ png: '!!' }, 'PUT')
    )
    expect(notPng.status).toBe(400)
    expect(((await notPng.json()) as ErrorBody).error.details).toBe('png: expected a base64 PNG')
    expect(diffusionCalls()).toEqual([
      'diffusion listVideoGallery {"offset":20,"limit":40,"includeArchived":true}',
      `diffusion setVideoGalleryFlags ${FAKE_VIDEO_ITEM.id} {"pinned":true}`,
      `diffusion exportVideoGalleryItem ${FAKE_VIDEO_ITEM.id} /out/a.webm`,
      `diffusion deleteVideoGalleryItems ${FAKE_VIDEO_ITEM.id}`,
      `diffusion setVideoPoster ${FAKE_VIDEO_ITEM.id} 12`,
    ])
  })

  it('takes a poster body larger than the control default, within its own cap', async () => {
    expect(MAX_POSTER_BODY_BYTES).toBe(24 * 1024 * 1024)
    const big = 'A'.repeat(9 * 1024 * 1024)
    const res = await h.get(
      `/atomic/v1/diffusion/video/gallery/${FAKE_VIDEO_ITEM.id}/poster`,
      json({ png: big }, 'PUT')
    )
    expect(res.status).toBe(200)
    const tooBig = await h.get(
      `/atomic/v1/diffusion/video/gallery/${FAKE_VIDEO_ITEM.id}/poster`,
      json({ png: 'A'.repeat(25 * 1024 * 1024) }, 'PUT')
    )
    expect(tooBig.status).toBe(400)
    expect(((await tooBig.json()) as ErrorBody).error.message).toBe('Request body is too large.')
  })
})
