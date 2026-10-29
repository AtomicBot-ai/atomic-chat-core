import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AudioRecipe } from '../contracts/index.js'
import { sampleAudioSpec, sampleWav } from '../../test/helpers/audio-fixtures.js'
import { AudioGallery, audioPath, audioRecipePath, isValidAudioId } from './gallery.js'
import { buildAudioRecipe, serializeAudioRecipe } from './recipe.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-core-audio-gallery-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const id = (n: number) => n.toString(16).padStart(32, '0')
const recipe = (n: number, createdAtMs = n): AudioRecipe =>
  buildAudioRecipe({
    jobId: id(n),
    request: { text: `clip ${n}` },
    spec: sampleAudioSpec(),
    seed: n,
    options: {},
    createdAtMs,
    durationMs: 10,
  })

describe('isValidAudioId', () => {
  it.each([
    [id(7), true],
    ['A'.repeat(32), false],
    ['../'.padEnd(32, 'a'), false],
    [id(7).slice(1), false],
  ])('%j → %s', (value, expected) => {
    expect(isValidAudioId(value)).toBe(expected)
  })
})

describe('AudioGallery', () => {
  it('saves the recipe and the clip, and lists them newest first with the header facts', async () => {
    const gallery = new AudioGallery()
    const out = join(dir, 'audios')
    const first = await gallery.save(out, recipe(1), sampleWav(24000, 1, 0.5))
    expect(first).toEqual({
      id: id(1),
      path: audioPath(out, id(1)),
      sampleRate: 24000,
      channels: 1,
      audioMs: 500,
      sizeBytes: sampleWav(24000, 1, 0.5).length,
      createdAtMs: 1,
      recipe: recipe(1),
    })
    expect(await readFile(audioRecipePath(out, id(1)), 'utf8')).toBe(serializeAudioRecipe(recipe(1)))
    await gallery.save(out, recipe(2), sampleWav(44100, 2, 1))
    await gallery.save(out, recipe(3), sampleWav(44100, 2, 0.25))
    const page = await gallery.list(out, { offset: 0, limit: 2 })
    expect(page.items.map((item) => item.id)).toEqual([id(3), id(2)])
    expect(page.items[1]).toMatchObject({ sampleRate: 44100, channels: 2, audioMs: 1000 })
    expect(page).toMatchObject({ hasMore: true, total: 3 })
    expect(await gallery.list(out, { offset: 2, limit: 2 })).toMatchObject({ hasMore: false, total: 3 })
    expect((await gallery.get(out, id(2)))?.recipe.text).toBe('clip 2')
    expect(await gallery.get(out, id(9))).toBeNull()
    // No temporary file is left behind.
    expect((await readdir(out)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('refuses to save something that is not a WAV, and an id that is not one', async () => {
    const gallery = new AudioGallery()
    await expect(gallery.save(dir, recipe(1), Buffer.from('{"audio":""}'))).rejects.toMatchObject({
      code: 'INVALID_OUTPUT',
    })
    await expect(gallery.save(dir, { ...recipe(1), jobId: '../x' }, sampleWav())).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    expect(await readdir(dir)).toEqual([])
  })

  it('never lists a WAV without our recipe, nor one whose recipe names another clip or does not parse', async () => {
    const gallery = new AudioGallery()
    await gallery.save(dir, recipe(1), sampleWav())
    await writeFile(audioPath(dir, id(2)), sampleWav())
    await writeFile(audioPath(dir, id(3)), sampleWav())
    await writeFile(audioRecipePath(dir, id(3)), serializeAudioRecipe(recipe(4)))
    await writeFile(audioPath(dir, id(5)), sampleWav())
    await writeFile(audioRecipePath(dir, id(5)), '{"jobId":')
    await writeFile(audioPath(dir, id(6)), 'not a wav')
    await writeFile(audioRecipePath(dir, id(6)), serializeAudioRecipe(recipe(6)))
    await writeFile(join(dir, 'song.wav'), sampleWav())
    await mkdir(join(dir, `${id(8)}.wav`))
    expect((await gallery.list(dir, { offset: 0, limit: 50 })).items.map((item) => item.id)).toEqual([id(1)])
    expect(await gallery.list(join(dir, 'missing'), { offset: 0, limit: 5 })).toEqual({
      items: [],
      hasMore: false,
      total: 0,
    })
  })

  it('deletes a clip and its recipe, leaves a foreign one alone, and is quiet about one already gone', async () => {
    const warnings: string[] = []
    const gallery = new AudioGallery((level, msg) => warnings.push(`${level} ${msg}`))
    await gallery.save(dir, recipe(1), sampleWav())
    await gallery.delete(dir, id(1))
    expect(await readdir(dir)).toEqual([])
    await gallery.delete(dir, id(1))

    await writeFile(audioPath(dir, id(2)), sampleWav())
    await expect(gallery.delete(dir, id(2))).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(warnings).toEqual([`warn refusing to delete foreign clip ${id(2)}`])
    // A recipe left behind by a clip already gone goes; a JSON that is not ours stays.
    await writeFile(audioRecipePath(dir, id(3)), serializeAudioRecipe(recipe(3)))
    await writeFile(audioRecipePath(dir, id(4)), '{"mine": false}')
    await gallery.delete(dir, id(3))
    await gallery.delete(dir, id(4))
    expect((await readdir(dir)).sort()).toEqual([`${id(2)}.wav`, `${id(4)}.json`])
    await expect(gallery.delete(dir, 'nope')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })
})
