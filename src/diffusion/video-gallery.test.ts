import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import { jobId, paintedPng, sampleVideoRecipe } from '../../test/helpers/diffusion-fixtures.js'
import { FLAGS_FILE, readFlags } from './gallery.js'
import {
  isValidVideoId,
  isWebm,
  MAX_POSTER_BYTES,
  VideoGallery,
  videoPath,
  videoPosterPath,
  videoRecipePath,
  WEBM_MAGIC,
} from './video-gallery.js'
import { parseVideoRecipe, serializeVideoRecipe } from './video-recipe.js'

const fixture = () => readFile(fileURLToPath(new URL('../../test/fixtures/webm/tiny.webm', import.meta.url)))

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-core-video-gallery-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false
  )

async function refusal(work: Promise<unknown>): Promise<AtomicCoreError> {
  const error = await work.then(
    () => undefined,
    (e: unknown) => e
  )
  expect(error).toBeInstanceOf(AtomicCoreError)
  return error as AtomicCoreError
}

describe('ids and containers', () => {
  it('validates ids strictly and names the three files', () => {
    expect(isValidVideoId(jobId(1))).toBe(true)
    expect(isValidVideoId('0123456789abcdef0123456789abcdef')).toBe(true)
    expect(isValidVideoId('0123456789ABCDEF0123456789abcdef')).toBe(false)
    expect(isValidVideoId('0123456789abcdef0123456789abcdef-00')).toBe(false)
    expect(isValidVideoId('../0123456789abcdef0123456789abc')).toBe(false)
    expect(isValidVideoId('')).toBe(false)
    expect(videoPath('/v', jobId(1))).toBe(join('/v', `${jobId(1)}.webm`))
    expect(videoRecipePath('/v', jobId(1))).toBe(join('/v', `${jobId(1)}.json`))
    expect(videoPosterPath('/v', jobId(1))).toBe(join('/v', `${jobId(1)}.thumb.png`))
  })

  it('recognises a WebM by its EBML magic and DocType, and nothing else', async () => {
    const webm = await fixture()
    expect(webm.subarray(0, 4).equals(WEBM_MAGIC)).toBe(true)
    expect(isWebm(webm)).toBe(true)
    expect(isWebm(webm.subarray(0, 6))).toBe(false)
    expect(isWebm(Buffer.from('RIFF....AVI '))).toBe(false)
    expect(isWebm(await paintedPng(4, 4))).toBe(false)
    // The same header with a Matroska DocType is not a WebM.
    const mkv = Buffer.from(webm)
    mkv.write('mkv?', mkv.indexOf(Buffer.from([0x42, 0x82])) + 3, 'latin1')
    expect(isWebm(mkv)).toBe(false)
    // A DocType with the wrong size marker is not read past.
    const odd = Buffer.from(webm)
    odd[odd.indexOf(Buffer.from([0x42, 0x82])) + 2] = 0x04
    expect(isWebm(odd)).toBe(false)
    expect(isWebm(Buffer.concat([WEBM_MAGIC, Buffer.alloc(8)]))).toBe(false)
  })
})

describe('VideoGallery.save', () => {
  it('writes the clip as it came with the recipe beside it, and answers the item', async () => {
    const gallery = new VideoGallery()
    const recipe = sampleVideoRecipe()
    const webm = await fixture()
    const { item, bytes } = await gallery.save(dir, recipe, webm)
    expect(bytes).toBe(webm)
    expect(item).toEqual({
      id: jobId(9),
      path: videoPath(dir, jobId(9)),
      posterPath: null,
      width: 768,
      height: 512,
      fps: 24,
      frameCount: 25,
      durationSecs: 25 / 24,
      sizeBytes: webm.length,
      createdAtMs: recipe.createdAtMs,
      pinned: false,
      archived: false,
      recipe,
    })
    expect((await readFile(item.path)).equals(webm)).toBe(true)
    expect(parseVideoRecipe(await readFile(videoRecipePath(dir, item.id), 'utf8'))).toEqual(recipe)
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(await gallery.get(dir, item.id)).toEqual(item)
    expect(await gallery.get(dir, jobId(8))).toBeNull()
  })

  it('refuses what the engine should never send, and names the videos folder in an I/O failure', async () => {
    const gallery = new VideoGallery()
    expect(
      (await refusal(gallery.save(dir, sampleVideoRecipe(), Buffer.from('not a webm')))).toJSON()
    ).toEqual({
      code: 'INVALID_OUTPUT',
      message: 'The video engine returned something that is not a WebM.',
    })
    const badId = await refusal(gallery.save(dir, sampleVideoRecipe({ jobId: '../escape' }), await fixture()))
    expect(badId.toJSON()).toEqual({
      code: 'INVALID_REQUEST',
      message: 'That is not a gallery video id.',
      details: '../escape',
    })
    await writeFile(join(dir, 'blocker'), 'a file, not a folder')
    expect(
      (await refusal(gallery.save(join(dir, 'blocker', 'videos'), sampleVideoRecipe(), await fixture())))
        .message
    ).toBe('Could not create the videos folder.')
    // A directory squatting on the clip's name makes the rename fail; the sidecar is not left alone.
    await mkdir(videoPath(dir, jobId(3)), { recursive: true })
    const rename = await refusal(gallery.save(dir, sampleVideoRecipe({ jobId: jobId(3) }), await fixture()))
    expect(rename.message).toBe('Could not finish writing the video.')
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})

describe('the poster', () => {
  it('is kept as the app rendered it, only for a clip that is ours, only as a PNG', async () => {
    const gallery = new VideoGallery()
    const { item } = await gallery.save(dir, sampleVideoRecipe(), await fixture())
    const png = await paintedPng(64, 42)
    const withPoster = await gallery.setPoster(dir, item.id, png)
    expect(withPoster.posterPath).toBe(videoPosterPath(dir, item.id))
    expect((await readFile(withPoster.posterPath as string)).equals(png)).toBe(true)
    expect((await gallery.get(dir, item.id))?.posterPath).toBe(withPoster.posterPath)
    // Replaced whole on a second upload.
    const other = await paintedPng(8, 8)
    await gallery.setPoster(dir, item.id, other)
    expect((await readFile(withPoster.posterPath as string)).equals(other)).toBe(true)

    expect((await refusal(gallery.setPoster(dir, item.id, Buffer.from('not a png')))).toJSON()).toEqual({
      code: 'INVALID_REQUEST',
      message: 'The poster is not a PNG.',
    })
    expect((await refusal(gallery.setPoster(dir, item.id, Buffer.alloc(MAX_POSTER_BYTES + 1)))).message).toBe(
      'The poster is too large.'
    )
    expect((await refusal(gallery.setPoster(dir, jobId(4), png))).code).toBe('JOB_NOT_FOUND')
    // A foreign clip takes no poster either.
    await writeFile(videoPath(dir, jobId(5)), await fixture())
    expect((await refusal(gallery.setPoster(dir, jobId(5), png))).code).toBe('JOB_NOT_FOUND')
    expect((await refusal(gallery.setPoster(dir, 'nope', png))).code).toBe('INVALID_REQUEST')
  })
})

describe('listing, flags, deleting and exporting', () => {
  it('lists owned clips newest first, hides archived ones, and pages', async () => {
    const gallery = new VideoGallery()
    const webm = await fixture()
    for (const [n, at] of [
      [1, 100],
      [2, 300],
      [3, 200],
    ] as const)
      await gallery.save(dir, sampleVideoRecipe({ jobId: jobId(n), createdAtMs: at }), webm)
    // A clip without a sidecar, and a sidecar that does not parse, are foreign.
    await writeFile(videoPath(dir, jobId(7)), webm)
    await writeFile(videoPath(dir, jobId(8)), webm)
    await writeFile(videoRecipePath(dir, jobId(8)), '{"jobId": 1}')
    await writeFile(join(dir, 'holiday.webm'), webm)
    const page = await gallery.list(dir, { offset: 0, limit: 10 })
    expect(page.items.map((i) => i.id)).toEqual([jobId(2), jobId(3), jobId(1)])
    expect([page.total, page.hasMore]).toEqual([3, false])
    const second = await gallery.list(dir, { offset: 1, limit: 1 })
    expect(second.items.map((i) => i.id)).toEqual([jobId(3)])
    expect([second.total, second.hasMore]).toEqual([3, true])
    expect(await gallery.get(dir, jobId(7))).toBeNull()
    expect(await gallery.list(join(dir, 'missing'), { offset: 0, limit: 10 })).toEqual({
      items: [],
      hasMore: false,
      total: 0,
    })

    const archived = await gallery.setFlags(dir, jobId(3), { archived: true })
    expect([archived.pinned, archived.archived]).toEqual([false, true])
    expect((await gallery.list(dir, { offset: 0, limit: 10 })).items.map((i) => i.id)).toEqual([
      jobId(2),
      jobId(1),
    ])
    expect((await gallery.list(dir, { offset: 0, limit: 10, includeArchived: true })).total).toBe(3)
    const pinned = await gallery.setFlags(dir, jobId(1), { pinned: true })
    expect(pinned.pinned).toBe(true)
    expect(await readFlags(dir)).toEqual(
      new Map([
        [jobId(1), { pinned: true, archived: false }],
        [jobId(3), { pinned: false, archived: true }],
      ])
    )
    // Clearing both flags drops the entry.
    await gallery.setFlags(dir, jobId(3), { archived: false })
    expect((await readFlags(dir)).has(jobId(3))).toBe(false)
    expect((await refusal(gallery.setFlags(dir, jobId(6), { pinned: true }))).code).toBe('JOB_NOT_FOUND')
    expect((await refusal(gallery.setFlags(dir, jobId(7), { pinned: true }))).toJSON()).toEqual({
      code: 'JOB_NOT_FOUND',
      message: 'That video is not an Atomic Chat gallery video.',
    })
  })

  it('deletes the clip, its sidecar, its poster and its flags, and leaves foreign clips alone', async () => {
    const warnings: string[] = []
    const gallery = new VideoGallery((_level, msg) => warnings.push(msg))
    const webm = await fixture()
    const { item } = await gallery.save(dir, sampleVideoRecipe({ jobId: jobId(1) }), webm)
    await gallery.setPoster(dir, item.id, await paintedPng(8, 8))
    await gallery.setFlags(dir, item.id, { pinned: true })
    await writeFile(videoPath(dir, jobId(7)), webm)
    await gallery.delete(dir, [item.id, jobId(7), jobId(9)])
    expect(await exists(item.path)).toBe(false)
    expect(await exists(videoRecipePath(dir, item.id))).toBe(false)
    expect(await exists(videoPosterPath(dir, item.id))).toBe(false)
    expect(await exists(videoPath(dir, jobId(7)))).toBe(true)
    expect(warnings).toEqual([`refusing to delete foreign video ${jobId(7)}`])
    expect(await readFlags(dir)).toEqual(new Map())
    // Nothing owned to delete leaves the flags file untouched.
    await rm(join(dir, FLAGS_FILE), { force: true })
    await gallery.delete(dir, [jobId(9)])
    expect(await exists(join(dir, FLAGS_FILE))).toBe(false)
    expect((await refusal(gallery.delete(dir, ['..']))).code).toBe('INVALID_REQUEST')
  })

  it('exports a byte-for-byte copy into a folder it creates', async () => {
    const gallery = new VideoGallery()
    const webm = await fixture()
    const { item } = await gallery.save(dir, sampleVideoRecipe(), webm)
    const target = join(dir, 'out', 'clip.webm')
    await gallery.export(dir, item.id, target)
    expect((await readFile(target)).equals(webm)).toBe(true)
    expect((await refusal(gallery.export(dir, jobId(2), target))).code).toBe('JOB_NOT_FOUND')
    await writeFile(join(dir, 'file'), 'x')
    expect((await refusal(gallery.export(dir, item.id, join(dir, 'file', 'clip.webm')))).message).toBe(
      'Could not create the destination folder.'
    )
    // The sidecar text is exactly what a reader sees.
    expect(await readFile(videoRecipePath(dir, item.id), 'utf8')).toBe(
      serializeVideoRecipe(sampleVideoRecipe())
    )
  })
})
