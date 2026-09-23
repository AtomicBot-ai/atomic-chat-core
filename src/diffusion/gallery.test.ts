/**
 * Hand-ported from the `#[test]` table of `gallery.rs` in `tauri-plugin-atomic-diffusion` (app commit
 * `767ff6350`).
 */
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import { jobId, paintedPng, sampleRecipe } from '../../test/helpers/diffusion-fixtures.js'
import {
  BLANK_SCAN_LIMIT,
  FLAGS_FILE,
  Gallery,
  isBlankOutput,
  isValidId,
  makeId,
  pngPath,
  readFlags,
  THUMB_EDGE,
  thumbPath,
  writeAtomic,
  writeFlags,
  writeThumbnail,
} from './gallery.js'
import { decodePng, encodePng, readPngHeader } from './png.js'
import { a1111Parameters, parseRecipe } from './recipe.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-core-gallery-'))
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

describe('ids', () => {
  it('are validated strictly', () => {
    expect(isValidId(makeId(jobId(1), 0))).toBe(true)
    expect(makeId(jobId(1), 3)).toBe('00000000000000000000000000000001-03')
    expect(isValidId('0123456789abcdef0123456789abcdef-03')).toBe(true)
    expect(isValidId('0123456789ABCDEF0123456789abcdef-03')).toBe(false)
    expect(isValidId('0123456789abcdef0123456789abcdef-3')).toBe(false)
    expect(isValidId('../0123456789abcdef0123456789abcd-03')).toBe(false)
    expect(isValidId('0123456789abcdef0123456789abcdef-03\n')).toBe(false)
    expect(isValidId('')).toBe(false)
  })
})

describe('Gallery.save', () => {
  it('writes a PNG that carries both text chunks, and a thumbnail beside it', async () => {
    const gallery = new Gallery()
    const recipe = sampleRecipe()
    const { item, bytes } = await gallery.save(dir, recipe, await paintedPng(64, 48))
    expect([item.width, item.height]).toEqual([64, 48])
    expect(item.recipe).toEqual(recipe)
    expect(item.id).toBe(makeId(jobId(7), 0))
    expect(item.path).toBe(pngPath(dir, item.id))
    expect(item.sizeBytes).toBe(bytes.length)
    expect(item.createdAtMs).toBe(recipe.createdAtMs)
    expect([item.pinned, item.archived]).toEqual([false, false])
    expect((await readFile(item.path)).equals(bytes)).toBe(true)
    expect(item.thumbnailPath).toBe(thumbPath(dir, item.id))
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([])

    // The header reader sees the same recipe without decoding pixels.
    const header = await readPngHeader(item.path)
    expect(parseRecipe(header?.texts.get('atomic') as string)).toEqual(recipe)
    expect(header?.texts.get('parameters')).toBe(a1111Parameters(recipe))
    // And the picture is still the picture.
    expect((await decodePng(bytes)).data.equals((await decodePng(await paintedPng(64, 48))).data)).toBe(true)

    // A small image keeps its size; a large one fits within 256 px and keeps its aspect ratio.
    const small = await decodePng(await readFile(item.thumbnailPath as string))
    expect([small.width, small.height]).toEqual([64, 48])
    const big = join(dir, 't.png')
    await writeThumbnail(await paintedPng(512, 256), big)
    const thumb = await decodePng(await readFile(big))
    expect([thumb.width, thumb.height]).toEqual([THUMB_EDGE, 128])
  })

  it('goes without a thumbnail for a PNG flavour it cannot decode, and says so in the log', async () => {
    const warnings: string[] = []
    const gallery = new Gallery((_level, msg) => warnings.push(msg))
    const palette = await readFile(new URL('../../test/fixtures/png/palette.png', import.meta.url))
    const { item } = await gallery.save(dir, sampleRecipe(), palette)
    expect(item.thumbnailPath).toBeNull()
    expect([item.width, item.height]).toEqual([8, 8])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(`thumbnail for ${item.id} failed`)
    expect((await gallery.get(dir, item.id))?.thumbnailPath).toBeNull()
  })

  it('leaves no temporary file behind when the rename fails', async () => {
    const id = makeId(jobId(9), 0)
    // A directory squatting on the target name makes the rename fail.
    await mkdir(pngPath(dir, id), { recursive: true })
    const error = await refusal(
      new Gallery().save(dir, sampleRecipe({ jobId: jobId(9) }), await paintedPng(8, 8))
    )
    expect(error.code).toBe('INTERNAL')
    expect(error.message).toBe('Could not finish writing the image.')
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('names the folder its caller chose in an atomic-write failure', async () => {
    await writeFile(join(dir, 'plain'), 'x')
    await writeAtomic(join(dir, 'plain'), 'y')
    expect(await readFile(join(dir, 'plain'), 'utf8')).toBe('y')
    const squatter = join(dir, 'taken')
    await mkdir(squatter)
    expect((await refusal(writeAtomic(squatter, 'z'))).message).toBe('Could not finish writing the image.')
    expect(
      (await refusal(writeAtomic(squatter, 'z', { write: 'no write', finish: 'no finish' }))).message
    ).toBe('no finish')
    expect(
      (await refusal(writeAtomic(join(dir, 'missing', 'x'), 'z', { write: 'no write', finish: 'f' }))).message
    ).toBe('no write')
  })

  it('refuses what the engine should never send', async () => {
    const gallery = new Gallery()
    expect((await refusal(gallery.save(dir, sampleRecipe(), Buffer.from('not a png')))).message).toBe(
      'The engine returned something that is not a PNG.'
    )
    const badId = await refusal(
      gallery.save(dir, sampleRecipe({ jobId: '../escape' }), await paintedPng(8, 8))
    )
    expect(badId.toJSON()).toEqual({
      code: 'INVALID_REQUEST',
      message: 'That is not a gallery image id.',
      details: '../escape-00',
    })
  })

  it('reports a folder it cannot create', async () => {
    await writeFile(join(dir, 'blocker'), 'a file, not a folder')
    const error = await refusal(
      new Gallery().save(join(dir, 'blocker', 'images'), sampleRecipe(), await paintedPng(8, 8))
    )
    expect(error.message).toBe('Could not create the images folder.')
  })
})

const flatPng = (value: number, edge = 16) =>
  encodePng({ width: edge, height: edge, channels: 3, data: Buffer.alloc(edge * edge * 3, value) })

describe('blank frames', () => {
  // `detects_only_uniform_black_or_white_failure_frames` (`gallery.rs`, app commit ec1fd3ea7).
  it('are all-white or all-black PNGs; anything unreadable is INVALID_OUTPUT', async () => {
    expect(await isBlankOutput(await flatPng(255))).toBe(true)
    expect(await isBlankOutput(await flatPng(0))).toBe(true)
    expect(await isBlankOutput(await flatPng(128))).toBe(false)
    expect(await isBlankOutput(await paintedPng(16, 16))).toBe(false)
    // A well-formed flavour this module does not decode is not called blank.
    const palette = await readFile(new URL('../../test/fixtures/png/palette.png', import.meta.url))
    expect(await isBlankOutput(palette)).toBe(false)
    const unreadable = await refusal(isBlankOutput(Buffer.from('not a png')))
    expect(unreadable.toJSON()).toEqual({
      code: 'INVALID_OUTPUT',
      message: 'The image engine returned an unreadable image.',
      details: 'not a PNG',
    })
  })

  // `item_from_path` (`gallery.rs`): an older build could save one; the listing hides it.
  it('an older build saved are hidden from the listing and from lookups, judged on the thumbnail', async () => {
    const warnings: string[] = []
    const gallery = new Gallery((_level, msg) => warnings.push(msg))
    const { item: blank } = await gallery.save(dir, sampleRecipe({ jobId: jobId(1) }), await flatPng(255, 64))
    const { item: real } = await gallery.save(
      dir,
      sampleRecipe({ jobId: jobId(2) }),
      await paintedPng(64, 64)
    )
    const page = await gallery.list(dir, { offset: 0, limit: 10, includeArchived: true })
    expect(page.items.map((item) => item.id)).toEqual([real.id])
    expect(await gallery.get(dir, blank.id)).toBeNull()
    expect((await refusal(gallery.setFlags(dir, blank.id, { pinned: true }))).code).toBe('JOB_NOT_FOUND')
    expect(warnings.filter((w) => w === `hiding blank gallery output ${blank.id}`)).toHaveLength(1)
    // The verdict is kept per file: a second listing does not decode or warn again.
    await gallery.list(dir, { offset: 0, limit: 10 })
    expect(warnings.filter((w) => w.startsWith('hiding'))).toHaveLength(1)

    // Without a thumbnail the PNG itself is judged; a rewritten file is judged again.
    await rm(thumbPath(dir, real.id))
    expect(await gallery.get(dir, real.id)).not.toBeNull()
    await rm(thumbPath(dir, blank.id))
    expect(await gallery.get(dir, blank.id)).toBeNull()

    // Deleting still works on a hidden item.
    await gallery.delete(dir, [blank.id])
    expect(await exists(blank.path)).toBe(false)
  })

  it('are not looked for in files too large to be one', async () => {
    const gallery = new Gallery()
    const { item } = await gallery.save(dir, sampleRecipe({ jobId: jobId(3) }), await flatPng(0, 16))
    await rm(thumbPath(dir, item.id))
    // Pad the PNG past the limit with a trailing chunk-free tail a reader ignores after IEND.
    const bytes = await readFile(item.path)
    await writeFile(item.path, Buffer.concat([bytes, Buffer.alloc(BLANK_SCAN_LIMIT)]))
    expect(await gallery.get(dir, item.id)).not.toBeNull()
  })
})

describe('foreign PNGs', () => {
  it('are neither listed nor deleted', async () => {
    const gallery = new Gallery()
    const foreignId = makeId(jobId(3), 0)
    const foreign = pngPath(dir, foreignId)
    await writeFile(foreign, await paintedPng(8, 8))
    await writeFile(join(dir, 'holiday.png'), await paintedPng(8, 8))
    const { item: own } = await gallery.save(
      dir,
      sampleRecipe({ jobId: jobId(4), createdAtMs: 5 }),
      await paintedPng(8, 8)
    )

    const page = await gallery.list(dir, { offset: 0, limit: 10, includeArchived: true })
    expect(page.total).toBe(1)
    expect(page.items[0]?.id).toBe(own.id)

    await gallery.delete(dir, [foreignId, own.id])
    expect(await exists(foreign), 'a foreign PNG must survive delete').toBe(true)
    expect(await exists(own.path)).toBe(false)
    expect(await exists(thumbPath(dir, own.id))).toBe(false)

    expect(await gallery.get(dir, foreignId)).toBeNull()
    expect(await gallery.get(dir, makeId(jobId(99), 0))).toBeNull()
    expect((await refusal(gallery.delete(dir, ['../etc/passwd']))).code).toBe('INVALID_REQUEST')
    expect((await refusal(gallery.get(dir, 'nope'))).code).toBe('INVALID_REQUEST')
  })

  it('include a PNG whose atomic chunk is not a recipe', async () => {
    const gallery = new Gallery()
    const { insertAfterHeader, textChunk } = await import('./png.js')
    const id = makeId(jobId(5), 0)
    const tagged = insertAfterHeader(await paintedPng(8, 8), [
      textChunk('atomic', '{"prompt":"half a recipe"}'),
    ])
    await writeFile(pngPath(dir, id), tagged as Buffer)
    expect((await gallery.list(dir, { offset: 0, limit: 10 })).total).toBe(0)
    await gallery.delete(dir, [id])
    expect(await exists(pngPath(dir, id))).toBe(true)
    const error = await refusal(gallery.setFlags(dir, id, { pinned: true }))
    expect(error.toJSON()).toEqual({
      code: 'JOB_NOT_FOUND',
      message: 'That image is not an Atomic Chat gallery image.',
    })
  })
})

describe('listing', () => {
  it('orders, paginates and honours flags', async () => {
    const gallery = new Gallery()
    const ids: string[] = []
    for (const [n, createdAtMs] of [
      [1, 10],
      [2, 30],
      [3, 20],
      [4, 40],
    ] as const) {
      const { item } = await gallery.save(
        dir,
        sampleRecipe({ jobId: jobId(n), createdAtMs }),
        await paintedPng(8, 8)
      )
      ids.push(item.id)
    }
    let page = await gallery.list(dir, { offset: 0, limit: 2 })
    expect(page.total).toBe(4)
    expect(page.hasMore).toBe(true)
    expect(page.items.map((i) => i.id)).toEqual([ids[3], ids[1]])
    page = await gallery.list(dir, { offset: 2, limit: 2 })
    expect(page.hasMore).toBe(false)
    expect(page.items.map((i) => i.id)).toEqual([ids[2], ids[0]])
    // A limit of zero still returns one item, and an offset past the end returns none.
    expect((await gallery.list(dir, { offset: 0, limit: 0 })).items).toHaveLength(1)
    expect(await gallery.list(dir, { offset: 9, limit: 2 })).toEqual({ items: [], hasMore: false, total: 4 })

    // Archive one: hidden by default, visible with includeArchived; the pin persists.
    const archivedId = ids[1] as string
    const item = await gallery.setFlags(dir, archivedId, { pinned: true, archived: true })
    expect([item.pinned, item.archived]).toEqual([true, true])
    expect((await readFlags(dir)).get(archivedId)).toEqual({ pinned: true, archived: true })
    page = await gallery.list(dir, { offset: 0, limit: 10 })
    expect(page.total).toBe(3)
    expect(page.items.every((i) => i.id !== archivedId)).toBe(true)
    page = await gallery.list(dir, { offset: 0, limit: 10, includeArchived: true })
    expect(page.total).toBe(4)
    expect(page.items.find((i) => i.id === archivedId)?.pinned).toBe(true)
    expect((await gallery.get(dir, archivedId))?.archived).toBe(true)

    // One flag at a time leaves the other alone; clearing both drops the entry.
    expect((await gallery.setFlags(dir, archivedId, { archived: false })).pinned).toBe(true)
    await gallery.setFlags(dir, archivedId, { pinned: false })
    expect((await readFlags(dir)).size).toBe(0)
    expect(JSON.parse(await readFile(join(dir, FLAGS_FILE), 'utf8'))).toEqual({})

    // Deleting an image drops its flags with it.
    await gallery.setFlags(dir, ids[0] as string, { pinned: true })
    await gallery.delete(dir, [ids[0] as string])
    expect((await readFlags(dir)).size).toBe(0)

    // Export is byte for byte.
    const target = join(dir, 'out', 'export.png')
    await gallery.export(dir, ids[2] as string, target)
    expect((await readFile(target)).equals(await readFile(pngPath(dir, ids[2] as string)))).toBe(true)
    expect((await refusal(gallery.export(dir, 'nope', target))).code).toBe('INVALID_REQUEST')
    const gone = await refusal(gallery.export(dir, makeId(jobId(77), 0), target))
    expect(gone.toJSON()).toEqual({
      code: 'JOB_NOT_FOUND',
      message: 'That image is no longer in the gallery.',
    })
    expect((await refusal(gallery.setFlags(dir, makeId(jobId(77), 0), { pinned: true }))).code).toBe(
      'JOB_NOT_FOUND'
    )
  })

  it('breaks a tie on the creation time by id, newest id first', async () => {
    const gallery = new Gallery()
    for (const n of [1, 3, 2])
      await gallery.save(dir, sampleRecipe({ jobId: jobId(n), createdAtMs: 50 }), await paintedPng(8, 8))
    const page = await gallery.list(dir, { offset: 0, limit: 10 })
    expect(page.items.map((i) => i.recipe.jobId)).toEqual([jobId(3), jobId(2), jobId(1)])
  })

  it('answers an empty page for a folder that does not exist', async () => {
    expect(await new Gallery().list(join(dir, 'missing'), { offset: 0, limit: 10 })).toEqual({
      items: [],
      hasMore: false,
      total: 0,
    })
  })

  it('reports an export it cannot complete', async () => {
    const gallery = new Gallery()
    const { item } = await gallery.save(dir, sampleRecipe(), await paintedPng(8, 8))
    await writeFile(join(dir, 'blocker'), 'a file')
    expect((await refusal(gallery.export(dir, item.id, join(dir, 'blocker', 'x', 'out.png')))).message).toBe(
      'Could not create the destination folder.'
    )
    await mkdir(join(dir, 'taken.png'))
    expect((await refusal(gallery.export(dir, item.id, join(dir, 'taken.png')))).message).toBe(
      'Could not export the image.'
    )
  })
})

describe('the flags file', () => {
  it('is read leniently per field and strictly per shape', async () => {
    await writeFile(
      join(dir, FLAGS_FILE),
      JSON.stringify({ a: { pinned: true }, b: { archived: true, extra: 1 } })
    )
    expect(await readFlags(dir)).toEqual(
      new Map([
        ['a', { pinned: true, archived: false }],
        ['b', { pinned: false, archived: true }],
      ])
    )
    for (const broken of ['not json', '[]', 'null', '{"a":1}', '{"a":{"pinned":"yes"}}', '{"a":[]}']) {
      await writeFile(join(dir, FLAGS_FILE), broken)
      expect((await readFlags(dir)).size, broken).toBe(0)
    }
    expect((await readFlags(join(dir, 'missing'))).size).toBe(0)
  })

  it('is written whole, sorted, through a temporary file', async () => {
    await writeFlags(
      dir,
      new Map([
        ['b', { pinned: true, archived: false }],
        ['a', { pinned: false, archived: true }],
      ])
    )
    expect(await readFile(join(dir, FLAGS_FILE), 'utf8')).toBe(
      '{\n  "a": {\n    "pinned": false,\n    "archived": true\n  },\n  "b": {\n    "pinned": true,\n    "archived": false\n  }\n}'
    )
    expect(await readdir(dir)).toEqual([FLAGS_FILE])
    const error = await refusal(writeFlags(join(dir, 'missing'), new Map()))
    expect(error.message).toBe('Could not write to the images folder.')
  })
})
