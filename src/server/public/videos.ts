/**
 * `/v1/videos`: an asynchronous facade over the video job runner in the shape of the OpenAI Videos
 * API. `POST` queues a clip and answers its video object at once; `GET /videos/{id}` is the poll,
 * `GET /videos/{id}/content` streams the WebM, `DELETE` cancels a running job or removes a finished
 * clip, `GET /videos` lists what is in memory and in the gallery. There is no job table: a running
 * job is the runner's record, a finished clip is its gallery item, so a completed video outlives a
 * restart of the core. The resident video model is the only model, and it is absent from `/models`.
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { GalleryVideoItem } from '../../contracts/index.js'
import { answer, invalidJsonMessage } from './exchange.js'
import type { Exchange } from './exchange.js'
import { errorBody, errorKindFor, mapError, modelMatches, ParamError } from './images-params.js'
import { IMAGES_BACKEND_LABEL } from './images.js'
import type { VideosBackend } from './types.js'
import {
  allowedVideoMethods,
  buildVideoRequest,
  parseListQuery,
  parseVideoParams,
  videoObjectFromItem,
  videoObjectFromJob,
} from './videos-params.js'
import type { OpenAiVideo, VideoPathMatch } from './videos-params.js'
import { readBody } from './wire.js'

export const NO_VIDEO_MODEL_MESSAGE = 'No video model loaded. Load a video model in Atomic Chat first.'
export const VIDEO_CONTENT_TYPE = 'video/webm'
/** How much of the gallery a listing looks at: the newest clips, which is what a client pages through. */
export const LIST_SCAN_LIMIT = 1000

const JSON_HEADERS: Array<[string, string]> = [['Content-Type', 'application/json']]

function fail(ex: Exchange, status: number, body: string, errorKind: string): void {
  ex.trace.errorKind = errorKind
  answer(ex, status, body, JSON_HEADERS)
}

const notFound = (ex: Exchange) =>
  fail(ex, 404, errorBody('Video not found.', 'invalid_request_error', 'not_found', null), 'not_found')

/** The video object of `id`: the runner's record while it has one, else the gallery's clip. */
async function lookup(
  videos: VideosBackend,
  id: string
): Promise<{ object: OpenAiVideo; item?: GalleryVideoItem } | undefined> {
  const job = videos.job(id)
  if (job) {
    const item = job.outputs[0]
    return item ? { object: videoObjectFromJob(job), item } : { object: videoObjectFromJob(job) }
  }
  const item = await videos.item(id)
  return item ? { object: videoObjectFromItem(item), item } : undefined
}

async function serveCreate(ex: Exchange, videos: VideosBackend): Promise<void> {
  const { trace } = ex
  let parsed: unknown
  try {
    parsed = JSON.parse((ex.body ?? (await readBody(ex.req))).toString('utf8'))
  } catch (e) {
    return fail(ex, 400, errorBody(invalidJsonMessage(e), 'invalid_request_error', null, null), 'bad_request')
  }
  let started: Awaited<ReturnType<VideosBackend['start']>>
  try {
    const params = parseVideoParams(parsed)
    trace.modelId = params.model ?? null
    const loaded = videos.loaded()
    if (!loaded || loaded.modality !== 'video' || !modelMatches(params.model, loaded))
      return fail(
        ex,
        503,
        errorBody(NO_VIDEO_MODEL_MESSAGE, 'server_error', 'model_not_loaded', null),
        'not_found'
      )
    trace.modelId = loaded.modelId
    trace.backend = IMAGES_BACKEND_LABEL
    started = await videos.start(buildVideoRequest(params, loaded))
  } catch (raw) {
    if (raw instanceof ParamError)
      return fail(ex, 400, errorBody(raw.message, 'invalid_request_error', null, raw.param), 'bad_request')
    const error = raw as { code?: string; message: string; details?: string }
    const mapped = mapError((error.code ?? 'INTERNAL') as Parameters<typeof mapError>[0])
    const message =
      mapped.status === 400 && error.details ? `${error.message} (${error.details})` : error.message
    return fail(
      ex,
      mapped.status,
      errorBody(message, mapped.type, mapped.code, null),
      errorKindFor(mapped.status)
    )
  }
  // Nobody awaits `done` here: the client polls, and the runner's record is the truth.
  void started.done
  const job = videos.job(started.id)
  if (!job)
    return fail(ex, 500, errorBody('The job vanished.', 'server_error', 'server_error', null), 'upstream')
  answer(ex, 200, JSON.stringify(videoObjectFromJob(job)), JSON_HEADERS)
}

async function serveList(ex: Exchange, videos: VideosBackend): Promise<void> {
  let query: ReturnType<typeof parseListQuery>
  try {
    query = parseListQuery(ex.query)
  } catch (raw) {
    if (!(raw instanceof ParamError)) throw raw
    return fail(ex, 400, errorBody(raw.message, 'invalid_request_error', null, raw.param), 'bad_request')
  }
  // Running and failed jobs first (they have no clip yet), then the gallery, newest first, no duplicates.
  const seen = new Set<string>()
  const all: OpenAiVideo[] = []
  for (const job of videos.jobs()) {
    if (job.state === 'completed') continue
    seen.add(job.id)
    all.push(videoObjectFromJob(job))
  }
  const page = await videos.list({ offset: 0, limit: LIST_SCAN_LIMIT, includeArchived: true })
  for (const item of page.items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    all.push(videoObjectFromItem(item))
  }
  let start = 0
  if (query.after !== undefined) {
    const at = all.findIndex((video) => video.id === query.after)
    start = at < 0 ? all.length : at + 1
  }
  const data = all.slice(start, start + query.limit)
  const body = {
    object: 'list',
    data,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
    has_more: start + data.length < all.length,
  }
  answer(ex, 200, JSON.stringify(body), JSON_HEADERS)
}

async function serveContent(ex: Exchange, videos: VideosBackend, id: string): Promise<void> {
  const found = await lookup(videos, id)
  if (!found || found.object.status !== 'completed' || !found.item) return notFound(ex)
  const variant = new URLSearchParams(ex.query ?? '').get('variant') ?? 'video'
  let path: string
  let type: string
  let name: string
  if (variant === 'video') {
    path = found.item.path
    type = VIDEO_CONTENT_TYPE
    name = `${id}.webm`
  } else if (variant === 'thumbnail' && found.item.posterPath) {
    path = found.item.posterPath
    type = 'image/png'
    name = `${id}.png`
  } else return notFound(ex)
  const meta = await stat(path).catch(() => undefined)
  if (!meta?.isFile()) return notFound(ex)
  ex.res.writeHead(
    200,
    [
      ['Content-Type', type],
      ['Content-Length', String(meta.size)],
      ['Content-Disposition', `inline; filename="${name}"`],
      ...ex.cors,
    ].flat()
  )
  await new Promise<void>((resolve) => {
    const stream = createReadStream(path)
    stream.on('error', () => {
      ex.res.destroy()
      resolve()
    })
    ex.res.on('close', resolve)
    stream.pipe(ex.res)
  })
}

async function serveDelete(ex: Exchange, videos: VideosBackend, id: string): Promise<void> {
  const job = videos.job(id)
  if (job && (job.state === 'queued' || job.state === 'generating')) await videos.cancel(id)
  const item = await videos.item(id)
  if (item) await videos.delete(id)
  else if (!job) return notFound(ex)
  answer(ex, 200, JSON.stringify({ id, object: 'video', deleted: true }), JSON_HEADERS)
}

/** Every `/videos*` request; `match` is what `matchVideoPath` made of the path. */
export async function serveVideos(ex: Exchange, match: VideoPathMatch): Promise<void> {
  const videos = ex.deps.videos
  const allowed = allowedVideoMethods(match)
  if (!allowed.includes(ex.method)) {
    ex.trace.errorKind = 'method_not_allowed'
    return answer(ex, 405, 'Method Not Allowed', [['Allow', allowed.join(', ')]])
  }
  if (!videos)
    return fail(
      ex,
      503,
      errorBody(NO_VIDEO_MODEL_MESSAGE, 'server_error', 'model_not_loaded', null),
      'not_found'
    )
  // Polls and downloads are client bookkeeping: never reported.
  if (ex.method === 'GET') ex.trace.skipEmit = true
  switch (match.kind) {
    case 'collection':
      return ex.method === 'POST' ? serveCreate(ex, videos) : serveList(ex, videos)
    case 'video': {
      if (ex.method === 'DELETE') return serveDelete(ex, videos, match.id)
      const found = await lookup(videos, match.id)
      return found ? answer(ex, 200, JSON.stringify(found.object), JSON_HEADERS) : notFound(ex)
    }
    default:
      return serveContent(ex, videos, match.id)
  }
}
