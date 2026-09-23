/**
 * The video gallery on disk: `<videoOutputDir>/<jobId>.webm` with its recipe as `<jobId>.json`
 * beside it, a `<jobId>.thumb.png` poster once the app rendered one, and the same `.flags.json`
 * as the image gallery, in its own folder. The core has no video decoder (AGENTS.md rule 8): it
 * checks the container's magic, writes the bytes as they came, and reads everything it knows about
 * a clip from the sidecar.
 *
 * A `.webm` without a parseable sidecar is somebody else's: it is never listed and never deleted,
 * even when it sits in the folder under a name that looks like ours.
 */

import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  GalleryFlags,
  GalleryListOptions,
  GalleryVideoItem,
  VideoGalleryPage,
  VideoRecipe,
} from '../contracts/index.js'
import { isWithin } from './containment.js'
import { diffusionError, ioError } from './errors.js'
import { readFlags, writeAtomic, writeFlags } from './gallery.js'
import type { FlagMap, GalleryLogger } from './gallery.js'
import { AsyncMutex } from './mutex.js'
import { isPng, parseHeader } from './png.js'
import { parseVideoRecipe, RECIPE_SIDECAR_SUFFIX, serializeVideoRecipe } from './video-recipe.js'

export const VIDEO_SUFFIX = '.webm'
export const POSTER_SUFFIX = '.thumb.png'
/** The app's poster is a small PNG; anything larger is not one. */
export const MAX_POSTER_BYTES = 16 * 1024 * 1024
/** How many sidecars a listing reads at once. */
const SCAN_CONCURRENCY = 16

/** The EBML header every WebM (and Matroska) file starts with. */
export const WEBM_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3])

/**
 * Whether `bytes` are a WebM file: the EBML magic, then a `DocType` of `webm` inside the header.
 * The only structural check the core can make without a codec; the app's player does the rest.
 */
export function isWebm(bytes: Buffer): boolean {
  if (bytes.length < 8 || !bytes.subarray(0, 4).equals(WEBM_MAGIC)) return false
  // The header is small; `DocType` (0x4282) carries its size in one byte for `webm`.
  const window = bytes.subarray(4, Math.min(bytes.length, 256))
  const at = window.indexOf(Buffer.from([0x42, 0x82]))
  if (at < 0 || at + 2 >= window.length) return false
  const size = window[at + 2] as number
  if ((size & 0x80) === 0) return false
  const length = size & 0x7f
  return window.subarray(at + 3, at + 3 + length).toString('latin1') === 'webm'
}

/** The write messages of the video folder, for the atomic writer the image gallery shares. */
export const VIDEO_WRITE_MESSAGES = {
  write: 'Could not write to the videos folder.',
  finish: 'Could not finish writing the video.',
}

/** `^[a-f0-9]{32}$`: the job id, which is also the file stem. */
export function isValidVideoId(id: string): boolean {
  return /^[a-f0-9]{32}$/.test(id)
}

export function videoPath(dir: string, id: string): string {
  return join(dir, `${id}${VIDEO_SUFFIX}`)
}

export function videoRecipePath(dir: string, id: string): string {
  return join(dir, `${id}${RECIPE_SIDECAR_SUFFIX}`)
}

export function videoPosterPath(dir: string, id: string): string {
  return join(dir, `${id}${POSTER_SUFFIX}`)
}

function checkedVideoPath(dir: string, id: string): string {
  if (!isValidVideoId(id)) throw diffusionError('INVALID_REQUEST', 'That is not a gallery video id.', id)
  const path = videoPath(dir, id)
  if (!isWithin(path, dir))
    throw diffusionError('INVALID_REQUEST', 'That video is outside the videos folder.', id)
  return path
}

const isFile = (path: string): Promise<boolean> =>
  stat(path).then(
    (s) => s.isFile(),
    () => false
  )

async function readRecipe(dir: string, id: string): Promise<VideoRecipe | undefined> {
  const text = await readFile(videoRecipePath(dir, id), 'utf8').catch(() => undefined)
  return text === undefined ? undefined : parseVideoRecipe(text)
}

async function itemFromRecipe(
  dir: string,
  id: string,
  path: string,
  recipe: VideoRecipe,
  flags: FlagMap
): Promise<GalleryVideoItem | undefined> {
  const meta = await stat(path).catch(() => undefined)
  if (!meta) return undefined
  const poster = videoPosterPath(dir, id)
  const flag = flags.get(id)
  return {
    id,
    path,
    posterPath: (await isFile(poster)) ? poster : null,
    width: recipe.width,
    height: recipe.height,
    fps: recipe.fps,
    frameCount: recipe.frameCount,
    durationSecs: recipe.fps > 0 ? recipe.frameCount / recipe.fps : 0,
    sizeBytes: meta.size,
    createdAtMs: recipe.createdAtMs,
    pinned: flag?.pinned ?? false,
    archived: flag?.archived ?? false,
    recipe,
  }
}

async function itemFromPath(
  dir: string,
  id: string,
  path: string,
  flags: FlagMap
): Promise<GalleryVideoItem | undefined> {
  const recipe = await readRecipe(dir, id)
  return recipe ? itemFromRecipe(dir, id, path, recipe, flags) : undefined
}

/** Every owned clip, newest first. */
async function scan(dir: string, flags: FlagMap): Promise<GalleryVideoItem[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  const ids = names
    .filter((name) => name.endsWith(VIDEO_SUFFIX))
    .map((name) => name.slice(0, -VIDEO_SUFFIX.length))
    .filter(isValidVideoId)
  const items: GalleryVideoItem[] = []
  for (let at = 0; at < ids.length; at += SCAN_CONCURRENCY) {
    const batch = ids.slice(at, at + SCAN_CONCURRENCY)
    const found = await Promise.all(batch.map((id) => itemFromPath(dir, id, videoPath(dir, id), flags)))
    for (const item of found) if (item) items.push(item)
  }
  return items.sort((a, b) => b.createdAtMs - a.createdAtMs || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
}

/**
 * The video gallery's operations. Like the image gallery, everything that touches the flags file
 * goes through one lock; the clips have unique names and need none.
 */
export class VideoGallery {
  private readonly flagsLock = new AsyncMutex()

  constructor(private readonly log: GalleryLogger = () => {}) {}

  /** Write the sidecar, then the clip, and answer the item with the bytes (the facade streams them). */
  async save(
    dir: string,
    recipe: VideoRecipe,
    webm: Buffer
  ): Promise<{ item: GalleryVideoItem; bytes: Buffer }> {
    await mkdir(dir, { recursive: true }).catch((error: unknown) => {
      throw ioError('Could not create the videos folder.', error)
    })
    const id = recipe.jobId
    const path = checkedVideoPath(dir, id)
    if (!isWebm(webm))
      throw diffusionError('INVALID_OUTPUT', 'The video engine returned something that is not a WebM.')
    // The sidecar first: a clip without one is foreign, so a crash between the two leaves nothing listed.
    await writeAtomic(videoRecipePath(dir, id), serializeVideoRecipe(recipe), VIDEO_WRITE_MESSAGES)
    await writeAtomic(path, webm, VIDEO_WRITE_MESSAGES)
    const flag = (await this.flagsLock.run(() => readFlags(dir))).get(id)
    return {
      item: {
        id,
        path,
        posterPath: null,
        width: recipe.width,
        height: recipe.height,
        fps: recipe.fps,
        frameCount: recipe.frameCount,
        durationSecs: recipe.fps > 0 ? recipe.frameCount / recipe.fps : 0,
        sizeBytes: webm.length,
        createdAtMs: recipe.createdAtMs,
        pinned: flag?.pinned ?? false,
        archived: flag?.archived ?? false,
        recipe,
      },
      bytes: webm,
    }
  }

  /** The poster the app rendered from the first frame: a PNG with a readable header, kept as is. */
  async setPoster(dir: string, id: string, png: Buffer): Promise<GalleryVideoItem> {
    const path = checkedVideoPath(dir, id)
    if (!(await isFile(path)) || (await readRecipe(dir, id)) === undefined)
      throw diffusionError('JOB_NOT_FOUND', 'That video is no longer in the gallery.')
    if (png.length > MAX_POSTER_BYTES)
      throw diffusionError('INVALID_REQUEST', 'The poster is too large.', `${png.length} bytes`)
    const header = isPng(png) ? parseHeader(png) : 'not-png'
    if (header === 'not-png' || header.header === undefined)
      throw diffusionError('INVALID_REQUEST', 'The poster is not a PNG.')
    await writeAtomic(videoPosterPath(dir, id), png, VIDEO_WRITE_MESSAGES)
    const flags = await this.flagsLock.run(() => readFlags(dir))
    const item = await itemFromPath(dir, id, path, flags)
    if (!item) throw diffusionError('JOB_NOT_FOUND', 'That video is no longer in the gallery.')
    return item
  }

  async get(dir: string, id: string): Promise<GalleryVideoItem | null> {
    const path = checkedVideoPath(dir, id)
    if (!(await isFile(path))) return null
    const flags = await this.flagsLock.run(() => readFlags(dir))
    return (await itemFromPath(dir, id, path, flags)) ?? null
  }

  async list(dir: string, options: GalleryListOptions): Promise<VideoGalleryPage> {
    const flags = await this.flagsLock.run(() => readFlags(dir))
    const all = (await scan(dir, flags)).filter((item) => options.includeArchived === true || !item.archived)
    const items = all.slice(options.offset, options.offset + Math.max(options.limit, 1))
    return { items, hasMore: options.offset + items.length < all.length, total: all.length }
  }

  /** Remove each clip, its sidecar, its poster and its flags entry. Foreign clips are left alone. */
  delete(dir: string, ids: readonly string[]): Promise<void> {
    return this.flagsLock.run(async () => {
      const flags = await readFlags(dir)
      let changed = false
      for (const id of ids) {
        const path = checkedVideoPath(dir, id)
        if (await isFile(path)) {
          if ((await readRecipe(dir, id)) === undefined) {
            this.log('warn', `refusing to delete foreign video ${id}`)
            continue
          }
          await rm(path).catch((error: unknown) => {
            throw ioError('Could not delete the video.', error)
          })
        }
        await rm(videoRecipePath(dir, id), { force: true }).catch(() => {})
        await rm(videoPosterPath(dir, id), { force: true }).catch(() => {})
        if (flags.delete(id)) changed = true
      }
      if (changed) await writeFlags(dir, flags)
    })
  }

  setFlags(dir: string, id: string, update: GalleryFlags): Promise<GalleryVideoItem> {
    return this.flagsLock.run(async () => {
      const path = checkedVideoPath(dir, id)
      if (!(await isFile(path)))
        throw diffusionError('JOB_NOT_FOUND', 'That video is no longer in the gallery.')
      const flags = await readFlags(dir)
      const entry = { ...(flags.get(id) ?? { pinned: false, archived: false }) }
      if (update.pinned !== undefined) entry.pinned = update.pinned
      if (update.archived !== undefined) entry.archived = update.archived
      // An entry with nothing set is not worth a line in the file.
      if (entry.pinned || entry.archived) flags.set(id, entry)
      else flags.delete(id)
      await writeFlags(dir, flags)
      const item = await itemFromPath(dir, id, path, flags)
      if (!item) throw diffusionError('JOB_NOT_FOUND', 'That video is not an Atomic Chat gallery video.')
      return item
    })
  }

  /** Byte-for-byte copy of the clip; the recipe stays behind with the gallery. */
  async export(dir: string, id: string, target: string): Promise<void> {
    const path = checkedVideoPath(dir, id)
    if (!(await isFile(path)))
      throw diffusionError('JOB_NOT_FOUND', 'That video is no longer in the gallery.')
    await mkdir(dirname(target), { recursive: true }).catch((error: unknown) => {
      throw ioError('Could not create the destination folder.', error)
    })
    await copyFile(path, target).catch((error: unknown) => {
      throw ioError('Could not export the video.', error)
    })
  }
}
