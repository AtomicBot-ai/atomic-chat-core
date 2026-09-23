/**
 * The gallery on disk: `<outputDir>/<jobId>-<index:02>.png` with the recipe inside the PNG, a small
 * thumbnail beside it, and a `.flags.json` for pin and archive. Port of `gallery.rs` in
 * `tauri-plugin-atomic-diffusion` (app commit `ec1fd3ea7`).
 *
 * A PNG without a valid `atomic` chunk is somebody else's: it is never listed and never deleted,
 * even when it sits in the output folder under a name that looks like ours.
 */

import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type {
  GalleryFlags,
  GalleryImageItem,
  GalleryListOptions,
  GalleryPage,
  ImageRecipe,
} from '../contracts/index.js'
import { isWithin } from './containment.js'
import { diffusionError, ioError } from './errors.js'
import { AsyncMutex } from './mutex.js'
import { decodePng, isBlankRaster, readPngHeader, thumbnailPng, UnsupportedPngError } from './png.js'
import type { RasterImage } from './png.js'
import { parseRecipe, RECIPE_KEYWORD, spliceRecipe } from './recipe.js'

export const FLAGS_FILE = '.flags.json'
export const THUMB_EDGE = 256
const THUMB_SUFFIX = '.thumb.png'
/** How many image headers a listing reads at once. */
const SCAN_CONCURRENCY = 16
/** A listing checks for blank frames only in files this small; real outputs are far larger. */
export const BLANK_SCAN_LIMIT = 128 * 1024

/**
 * sd.cpp can finish a job after a numerical overflow and return a frame whose every pixel is pure
 * white or pure black: not a generated image. Bytes that are not a readable PNG are
 * `INVALID_OUTPUT`; a well-formed PNG of a kind this module does not decode is not called blank.
 */
export async function isBlankOutput(png: Buffer): Promise<boolean> {
  let image: RasterImage
  try {
    image = await decodePng(png)
  } catch (error) {
    if (error instanceof UnsupportedPngError) return false
    throw diffusionError(
      'INVALID_OUTPUT',
      'The image engine returned an unreadable image.',
      error instanceof Error ? error.message : String(error)
    )
  }
  return isBlankRaster(image)
}

/** Whether the gallery item `id` is a blank frame, judged the way `Gallery` does it. */
type BlankCheck = (dir: string, id: string, path: string) => Promise<boolean>

export interface FlagEntry {
  pinned: boolean
  archived: boolean
}
export type FlagMap = Map<string, FlagEntry>

/** `^[a-f0-9]{32}-\d{2}$` */
export function isValidId(id: string): boolean {
  return /^[a-f0-9]{32}-[0-9]{2}$/.test(id)
}

export function makeId(jobId: string, index: number): string {
  return `${jobId}-${String(index).padStart(2, '0')}`
}

export function pngPath(dir: string, id: string): string {
  return join(dir, `${id}.png`)
}

export function thumbPath(dir: string, id: string): string {
  return join(dir, `${id}${THUMB_SUFFIX}`)
}

function checkedPngPath(dir: string, id: string): string {
  if (!isValidId(id)) throw diffusionError('INVALID_REQUEST', 'That is not a gallery image id.', id)
  const path = pngPath(dir, id)
  if (!isWithin(path, dir))
    throw diffusionError('INVALID_REQUEST', 'That image is outside the gallery folder.', id)
  return path
}

const isFile = (path: string): Promise<boolean> =>
  stat(path).then(
    (s) => s.isFile(),
    () => false
  )

export async function readFlags(dir: string): Promise<FlagMap> {
  const flags: FlagMap = new Map()
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(join(dir, FLAGS_FILE), 'utf8'))
  } catch {
    return flags
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return flags
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    // One malformed entry invalidated the whole file for the plugin's serde; keep that.
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return new Map()
    const entry = value as Record<string, unknown>
    const pinned = entry['pinned'] ?? false
    const archived = entry['archived'] ?? false
    if (typeof pinned !== 'boolean' || typeof archived !== 'boolean') return new Map()
    flags.set(id, { pinned, archived })
  }
  return flags
}

/** What a failed write is called; the video gallery names its own folder. */
export interface WriteMessages {
  write: string
  finish: string
}
const IMAGE_WRITE_MESSAGES: WriteMessages = {
  write: 'Could not write to the images folder.',
  finish: 'Could not finish writing the image.',
}

/** Write a file through a hidden temporary sibling, so a reader never sees half of it. */
export async function writeAtomic(
  target: string,
  bytes: Buffer | string,
  messages: WriteMessages = IMAGE_WRITE_MESSAGES
): Promise<void> {
  const tmp = join(dirname(target), `.${basename(target)}.tmp`)
  try {
    await writeFile(tmp, bytes)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw ioError(messages.write, error)
  }
  try {
    await rename(tmp, target)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw ioError(messages.finish, error)
  }
}

export function writeFlags(dir: string, flags: FlagMap): Promise<void> {
  const sorted = Object.fromEntries([...flags.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  return writeAtomic(join(dir, FLAGS_FILE), JSON.stringify(sorted, null, 2))
}

/** A 256 px PNG beside the image. Fails for a PNG flavour the decoder does not read; the caller goes without. */
export async function writeThumbnail(png: Buffer, path: string): Promise<void> {
  await writeAtomic(path, await thumbnailPng(png, THUMB_EDGE))
}

async function itemFromPath(
  dir: string,
  id: string,
  path: string,
  flags: FlagMap,
  isBlank: BlankCheck
): Promise<GalleryImageItem | undefined> {
  if (await isBlank(dir, id, path)) return undefined
  const header = await readPngHeader(path)
  const text = header?.texts.get(RECIPE_KEYWORD)
  const recipe = text === undefined ? undefined : parseRecipe(text)
  if (!header || !recipe) return undefined
  const meta = await stat(path).catch(() => undefined)
  if (!meta) return undefined
  const thumb = thumbPath(dir, id)
  const flag = flags.get(id)
  return {
    id,
    path,
    thumbnailPath: (await isFile(thumb)) ? thumb : null,
    width: header.width,
    height: header.height,
    sizeBytes: meta.size,
    createdAtMs: recipe.createdAtMs,
    pinned: flag?.pinned ?? false,
    archived: flag?.archived ?? false,
    recipe,
  }
}

/** Every owned image, newest first. */
async function scan(dir: string, flags: FlagMap, isBlank: BlankCheck): Promise<GalleryImageItem[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  const ids = names
    .filter((name) => name.endsWith('.png'))
    .map((name) => name.slice(0, -'.png'.length))
    .filter(isValidId)
  const items: GalleryImageItem[] = []
  for (let at = 0; at < ids.length; at += SCAN_CONCURRENCY) {
    const batch = ids.slice(at, at + SCAN_CONCURRENCY)
    const found = await Promise.all(
      batch.map((id) => itemFromPath(dir, id, pngPath(dir, id), flags, isBlank))
    )
    for (const item of found) if (item) items.push(item)
  }
  return items.sort((a, b) => b.createdAtMs - a.createdAtMs || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
}

export interface GalleryLogger {
  (level: 'warn', msg: string): void
}

/**
 * The gallery's operations. The flags file is read and rewritten whole, so everything that touches
 * it goes through one lock; the images themselves have unique names and need none.
 */
export class Gallery {
  private readonly flagsLock = new AsyncMutex()
  /** The last verdict per small file, so a listing decodes each thumbnail once rather than every time. */
  private readonly blankFiles = new Map<string, { size: number; mtimeMs: number; blank: boolean }>()
  private readonly isBlank: BlankCheck = (dir, id, path) => this.isBlankItem(dir, id, path)

  constructor(private readonly log: GalleryLogger = () => {}) {}

  /**
   * A blank frame an older engine build saved is hidden from the listing and from lookups: judged on
   * the thumbnail (the PNG when there is none) when that file is small enough to be one. A file
   * that cannot be read or decoded is not blank.
   */
  private async isBlankItem(dir: string, id: string, path: string): Promise<boolean> {
    const thumb = thumbPath(dir, id)
    const file = (await isFile(thumb)) ? thumb : path
    const meta = await stat(file).catch(() => undefined)
    if (!meta || meta.size > BLANK_SCAN_LIMIT) return false
    const known = this.blankFiles.get(file)
    if (known && known.size === meta.size && known.mtimeMs === meta.mtimeMs) return known.blank
    const blank = await readFile(file)
      .then(isBlankOutput, () => false)
      .catch(() => false)
    this.blankFiles.set(file, { size: meta.size, mtimeMs: meta.mtimeMs, blank })
    if (blank) this.log('warn', `hiding blank gallery output ${id}`)
    return blank
  }

  /**
   * Splice the recipe in, write `<id>.png`, write the thumbnail, and return the item with the final
   * bytes (the OpenAI facade answers with them).
   */
  async save(
    dir: string,
    recipe: ImageRecipe,
    png: Buffer
  ): Promise<{ item: GalleryImageItem; bytes: Buffer }> {
    await mkdir(dir, { recursive: true }).catch((error: unknown) => {
      throw ioError('Could not create the images folder.', error)
    })
    const id = makeId(recipe.jobId, recipe.index)
    const path = checkedPngPath(dir, id)
    const bytes = spliceRecipe(png, recipe)
    await writeAtomic(path, bytes)

    const thumb = thumbPath(dir, id)
    const thumbnailPath = await writeThumbnail(bytes, thumb).then(
      () => thumb,
      (error: unknown) => {
        this.log(
          'warn',
          `thumbnail for ${id} failed: ${error instanceof Error ? error.message : String(error)}`
        )
        return null
      }
    )
    const header = await readPngHeader(path)
    if (!header) throw diffusionError('INTERNAL', 'The saved PNG could not be read back.')
    const flag = (await this.flagsLock.run(() => readFlags(dir))).get(id)
    return {
      item: {
        id,
        path,
        thumbnailPath,
        width: header.width,
        height: header.height,
        sizeBytes: bytes.length,
        createdAtMs: recipe.createdAtMs,
        pinned: flag?.pinned ?? false,
        archived: flag?.archived ?? false,
        recipe,
      },
      bytes,
    }
  }

  async get(dir: string, id: string): Promise<GalleryImageItem | null> {
    const path = checkedPngPath(dir, id)
    if (!(await isFile(path))) return null
    const flags = await this.flagsLock.run(() => readFlags(dir))
    return (await itemFromPath(dir, id, path, flags, this.isBlank)) ?? null
  }

  async list(dir: string, options: GalleryListOptions): Promise<GalleryPage> {
    const flags = await this.flagsLock.run(() => readFlags(dir))
    const all = (await scan(dir, flags, this.isBlank)).filter(
      (item) => options.includeArchived === true || !item.archived
    )
    const items = all.slice(options.offset, options.offset + Math.max(options.limit, 1))
    return { items, hasMore: options.offset + items.length < all.length, total: all.length }
  }

  /** Remove each PNG, its thumbnail and its flags entry. Foreign PNGs are left alone. */
  delete(dir: string, ids: readonly string[]): Promise<void> {
    return this.flagsLock.run(async () => {
      const flags = await readFlags(dir)
      let changed = false
      for (const id of ids) {
        const path = checkedPngPath(dir, id)
        if (await isFile(path)) {
          const text = (await readPngHeader(path))?.texts.get(RECIPE_KEYWORD)
          if (text === undefined || !parseRecipe(text)) {
            this.log('warn', `refusing to delete foreign image ${id}`)
            continue
          }
          await rm(path).catch((error: unknown) => {
            throw ioError('Could not delete the image.', error)
          })
        }
        await rm(thumbPath(dir, id), { force: true }).catch(() => {})
        this.blankFiles.delete(path)
        this.blankFiles.delete(thumbPath(dir, id))
        if (flags.delete(id)) changed = true
      }
      if (changed) await writeFlags(dir, flags)
    })
  }

  setFlags(dir: string, id: string, update: GalleryFlags): Promise<GalleryImageItem> {
    return this.flagsLock.run(async () => {
      const path = checkedPngPath(dir, id)
      if (!(await isFile(path)))
        throw diffusionError('JOB_NOT_FOUND', 'That image is no longer in the gallery.')
      const flags = await readFlags(dir)
      const entry = { ...(flags.get(id) ?? { pinned: false, archived: false }) }
      if (update.pinned !== undefined) entry.pinned = update.pinned
      if (update.archived !== undefined) entry.archived = update.archived
      // An entry with nothing set is not worth a line in the file.
      if (entry.pinned || entry.archived) flags.set(id, entry)
      else flags.delete(id)
      await writeFlags(dir, flags)
      const item = await itemFromPath(dir, id, path, flags, this.isBlank)
      if (!item) throw diffusionError('JOB_NOT_FOUND', 'That image is not an Atomic Chat gallery image.')
      return item
    })
  }

  /** Byte-for-byte copy, keeping the embedded recipe. */
  async export(dir: string, id: string, target: string): Promise<void> {
    const path = checkedPngPath(dir, id)
    if (!(await isFile(path)))
      throw diffusionError('JOB_NOT_FOUND', 'That image is no longer in the gallery.')
    await mkdir(dirname(target), { recursive: true }).catch((error: unknown) => {
      throw ioError('Could not create the destination folder.', error)
    })
    await copyFile(path, target).catch((error: unknown) => {
      throw ioError('Could not export the image.', error)
    })
  }
}
