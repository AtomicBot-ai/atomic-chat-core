/**
 * The audio gallery on disk: `<outputDir>/<jobId>.wav` with its recipe as `<jobId>.json` beside it.
 * The core checks the WAV header, writes the bytes as they came, and reads the clip's length from the
 * header again when it lists it.
 *
 * A `.wav` without a parseable recipe is somebody else's: it is never listed and never deleted, even
 * when it sits in the folder under a name that looks like ours.
 */

import { mkdir, open, readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AudioGalleryItem,
  AudioGalleryListOptions,
  AudioGalleryPage,
  AudioRecipe,
} from '../contracts/index.js'
import { isWithin, writeAtomic } from '../diffusion/index.js'
import { audioError, audioIoError } from './errors.js'
import { parseAudioRecipe, serializeAudioRecipe } from './recipe.js'
import { parseWav } from './wav.js'
import type { WavInfo } from './wav.js'

export const AUDIO_SUFFIX = '.wav'
export const RECIPE_SUFFIX = '.json'
/** How much of a WAV a listing reads for its header. */
const HEADER_BYTES = 64 * 1024
/** How many clips a listing reads at once. */
const SCAN_CONCURRENCY = 16

const WRITE_MESSAGES = {
  write: 'Could not write to the audio folder.',
  finish: 'Could not finish writing the clip.',
}

/** `^[a-f0-9]{32}$`: the job id, which is also the file stem. */
export function isValidAudioId(id: string): boolean {
  return /^[a-f0-9]{32}$/.test(id)
}

export function audioPath(dir: string, id: string): string {
  return join(dir, `${id}${AUDIO_SUFFIX}`)
}

export function audioRecipePath(dir: string, id: string): string {
  return join(dir, `${id}${RECIPE_SUFFIX}`)
}

function checkedId(dir: string, id: string): void {
  if (!isValidAudioId(id)) throw audioError('INVALID_REQUEST', 'That is not a gallery clip id.', id)
  if (!isWithin(audioPath(dir, id), dir))
    throw audioError('INVALID_REQUEST', 'That clip is outside the audio folder.', id)
}

async function readRecipe(dir: string, id: string): Promise<AudioRecipe | undefined> {
  const text = await readFile(audioRecipePath(dir, id), 'utf8').catch(() => undefined)
  const recipe = text === undefined ? undefined : parseAudioRecipe(text)
  // A recipe that names another job is not this clip's.
  return recipe?.jobId === id ? recipe : undefined
}

/** The header of the WAV at `path`, from its first bytes; `undefined` when it is missing or not a WAV. */
async function readWavHeader(path: string): Promise<{ info: WavInfo; size: number } | undefined> {
  const handle = await open(path, 'r').catch(() => undefined)
  if (!handle) return undefined
  try {
    const { size } = await handle.stat()
    const buffer = Buffer.alloc(Math.min(size, HEADER_BYTES))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const info = parseWav(buffer.subarray(0, bytesRead), size)
    return info ? { info, size } : undefined
  } catch {
    return undefined
  } finally {
    await handle.close().catch(() => {})
  }
}

function itemOf(
  id: string,
  path: string,
  info: WavInfo,
  size: number,
  recipe: AudioRecipe
): AudioGalleryItem {
  return {
    id,
    path,
    sampleRate: info.sampleRate,
    channels: info.channels,
    audioMs: info.audioMs,
    sizeBytes: size,
    createdAtMs: recipe.createdAtMs,
    recipe,
  }
}

async function itemFromDisk(dir: string, id: string): Promise<AudioGalleryItem | undefined> {
  const recipe = await readRecipe(dir, id)
  if (!recipe) return undefined
  const path = audioPath(dir, id)
  const header = await readWavHeader(path)
  return header ? itemOf(id, path, header.info, header.size, recipe) : undefined
}

/** The clips of one folder. Every clip has a unique name, so no lock is needed. */
export class AudioGallery {
  constructor(private readonly log: (level: 'info' | 'warn', msg: string) => void = () => {}) {}

  /** Write the recipe, then the clip, and answer the item. The WAV must be one. */
  async save(dir: string, recipe: AudioRecipe, wav: Buffer): Promise<AudioGalleryItem> {
    const id = recipe.jobId
    checkedId(dir, id)
    const info = parseWav(wav)
    if (!info) throw audioError('INVALID_OUTPUT', 'The audio engine returned something that is not a WAV.')
    await mkdir(dir, { recursive: true }).catch((error: unknown) => {
      throw audioIoError('Could not create the audio folder.', error)
    })
    // The recipe first: a clip without one is foreign, so a crash between the two leaves nothing listed.
    await writeAtomic(audioRecipePath(dir, id), serializeAudioRecipe(recipe), WRITE_MESSAGES)
    await writeAtomic(audioPath(dir, id), wav, WRITE_MESSAGES)
    return itemOf(id, audioPath(dir, id), info, wav.length, recipe)
  }

  async get(dir: string, id: string): Promise<AudioGalleryItem | null> {
    checkedId(dir, id)
    return (await itemFromDisk(dir, id)) ?? null
  }

  /** Our clips, newest first, `limit` of them from `offset`. */
  async list(dir: string, options: AudioGalleryListOptions): Promise<AudioGalleryPage> {
    const names = await readdir(dir).catch(() => [] as string[])
    const ids = names
      .filter((name) => name.endsWith(AUDIO_SUFFIX))
      .map((name) => name.slice(0, -AUDIO_SUFFIX.length))
      .filter(isValidAudioId)
    const all: AudioGalleryItem[] = []
    for (let at = 0; at < ids.length; at += SCAN_CONCURRENCY) {
      const found = await Promise.all(ids.slice(at, at + SCAN_CONCURRENCY).map((id) => itemFromDisk(dir, id)))
      for (const item of found) if (item) all.push(item)
    }
    all.sort((a, b) => b.createdAtMs - a.createdAtMs || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    const items = all.slice(options.offset, options.offset + Math.max(options.limit, 1))
    return { items, hasMore: options.offset + items.length < all.length, total: all.length }
  }

  /**
   * Remove a clip and its recipe. A clip that is already gone is not an error; a WAV without our
   * recipe is foreign and refused.
   */
  async delete(dir: string, id: string): Promise<void> {
    checkedId(dir, id)
    const path = audioPath(dir, id)
    const exists = await stat(path).then(
      (s) => s.isFile(),
      () => false
    )
    const ours = (await readRecipe(dir, id)) !== undefined
    if (exists) {
      if (!ours) {
        this.log('warn', `refusing to delete foreign clip ${id}`)
        throw audioError('INVALID_REQUEST', 'That file is not an Atomic Chat clip.', id)
      }
      await rm(path).catch((error: unknown) => {
        throw audioIoError('Could not delete the clip.', error)
      })
    }
    // A recipe left behind by a clip already gone goes too; a JSON that is not our recipe stays.
    if (ours) await rm(audioRecipePath(dir, id), { force: true }).catch(() => {})
  }
}
