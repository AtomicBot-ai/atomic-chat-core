/**
 * Live check of the embedding module (ADR 2026-10-07-embedding-models-are-their-own-core-module)
 * against a real ggml-org llama.cpp build and a real embedding GGUF: the core picks the upstream pack,
 * starts it with its own argv, reads the vector length and modalities, and the public `/v1/embeddings`
 * answers by the model's name: text, and with a projector images and audio, which land in one space.
 *
 * Opt in with:
 *   ATOMIC_LIVE=1
 *   ATOMIC_LIVE_EMBEDDING_BIN=/path/to/<llama-bNNNNN>/llama-server    (EmbeddingGemma 2 needs ≥ b11454)
 *   ATOMIC_LIVE_EMBEDDING_MODEL=/path/to/embeddinggemma-2-Q8_0.gguf   (unsloth/embeddinggemma-2-GGUF, 310 MB)
 *   ATOMIC_LIVE_EMBEDDING_MMPROJ=/path/to/mmproj-Q8_0.gguf            (optional, 555 MB: images, and audio when it has an encoder)
 *   ATOMIC_LIVE_EMBEDDING_TAG=b11463                                  (optional; the tag the pack is installed under)
 */
import { chmod, cp, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../helpers/tmp-data-folder.js'
import { AtomicCore } from '../../src/core/index.js'
import { llamaServerExeName } from '../../src/config/index.js'

const BIN = process.env['ATOMIC_LIVE_EMBEDDING_BIN'] ?? ''
const MODEL = process.env['ATOMIC_LIVE_EMBEDDING_MODEL'] ?? ''
const MMPROJ = process.env['ATOMIC_LIVE_EMBEDDING_MMPROJ'] ?? ''
const TAG = process.env['ATOMIC_LIVE_EMBEDDING_TAG'] ?? 'b11463'
const ENABLED = process.env['ATOMIC_LIVE'] === '1' && BIN !== '' && MODEL !== ''

/** The backend id this host's upstream build is published under. */
function hostBackend(): string {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'macos-arm64' : 'macos-x64'
  if (process.platform === 'win32') return 'win-cpu-x64'
  return 'ubuntu-x64'
}

const cos = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0)

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buf) {
    let c = (crc ^ byte) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** A solid-colour PNG, built here so the test carries no binary fixture. */
function solidPng(size: number, [r, g, b]: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const typed = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(typed))
    return Buffer.concat([len, typed, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc((size * 3 + 1) * size)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) raw.set([r, g, b], y * (size * 3 + 1) + 1 + x * 3)
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Three seconds of a 16 kHz mono sine as a WAV file. */
function sineWav(seconds: number, freq: number): Buffer {
  const rate = 16_000
  const data = Buffer.alloc(rate * seconds * 2)
  for (let i = 0; i < rate * seconds; i++)
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12_000), i * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

let data: TmpDataFolder
let core: AtomicCore

describe.skipIf(!ENABLED)('a real upstream llama.cpp embedding model', () => {
  beforeAll(async () => {
    data = await makeTmpDataFolder('atomic-core-live-embedding-')
    // The whole folder: llama-server links against the ggml libraries beside it.
    const packDir = join(
      data.layout.provider('llamacpp-upstream').backendsDir,
      TAG,
      hostBackend(),
      'build',
      'bin'
    )
    await mkdir(packDir, { recursive: true })
    await cp(dirname(BIN), packDir, { recursive: true })
    if (process.platform !== 'win32') await chmod(join(packDir, llamaServerExeName(process.platform)), 0o755)
    core = await AtomicCore.create({ dataFolder: data.root, controlPort: 0 })
  }, 120_000)

  afterAll(async () => {
    await core?.shutdown()
    await data?.cleanup()
  })

  it('starts on the upstream pack and serves /v1/embeddings by name', async () => {
    await core.embedding.configure({
      enabled: true,
      model_path: MODEL,
      mmproj_path: MMPROJ,
      model_id: 'live-embedding',
      ctx_size: 4096,
      image_max_tokens: MMPROJ ? 280 : 0,
      startup_timeout_secs: 300,
    })
    const status = await core.embedding.load()
    expect(status).toMatchObject({
      state: 'ready',
      model_id: 'live-embedding',
      engine: { provider: 'llamacpp-upstream' },
    })
    expect(status.dims).toBeGreaterThan(0)
    if (MMPROJ) expect(status.modalities).toEqual(expect.arrayContaining(['text', 'image']))

    const server = await core.startPublicServer({ port: 0 })
    const base = `http://127.0.0.1:${server.port}/v1`
    const embed = async (input: unknown, extra: Record<string, unknown> = {}) => {
      const res = await fetch(`${base}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'live-embedding', input, ...extra }),
      })
      return { status: res.status, body: (await res.json()) as { data?: Array<{ embedding: number[] }> } }
    }
    const vectors = async (input: unknown[]) => {
      const res = await embed(input)
      expect(res.status).toBe(200)
      return (res.body.data ?? []).map((d) => d.embedding)
    }

    const models = (await (await fetch(`${base}/models`)).json()) as {
      data: Array<{ id: string; owned_by: string }>
    }
    expect(models.data).toContainEqual(
      expect.objectContaining({ id: 'live-embedding', owned_by: 'atomic-embedding' })
    )

    const [q, relevant, other] = await vectors([
      'task: search result | query: how do I bake sourdough bread',
      'title: none | text: Mix flour, water and starter, let the dough rise overnight, then bake at 230C.',
      'title: none | text: The stock market closed higher today after the central bank decision.',
    ])
    expect(q).toHaveLength(status.dims as number)
    expect(cos(q!, relevant!)).toBeGreaterThan(cos(q!, other!))

    expect((await embed('x', { dimensions: 7 })).status).toBe(400)
    // Another name is not the module's: it goes to the sessions, of which there are none.
    const elsewhere = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'not-loaded', input: 'x' }),
    })
    expect(elsewhere.status).toBe(503)

    if (MMPROJ) {
      const image = (rgb: [number, number, number]) => ({
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${solidPng(224, rgb).toString('base64')}` },
          },
        ],
      })
      const [red, blue, redText, blueText] = await vectors([
        image([220, 20, 20]),
        image([20, 40, 220]),
        'a solid red square',
        'a solid blue square',
      ])
      expect(cos(red!, redText!)).toBeGreaterThan(cos(red!, blueText!))
      expect(cos(blue!, blueText!)).toBeGreaterThan(cos(blue!, redText!))

      const wav = {
        content: [{ type: 'input_audio', input_audio: { data: sineWav(3, 440).toString('base64') } }],
      }
      if (status.modalities.includes('audio')) {
        const [audio] = await vectors([wav])
        expect(audio).toHaveLength(status.dims as number)
      } else {
        // A model without an audio encoder: refused by the core, not a 500 from the engine.
        expect((await embed([wav])).status).toBe(400)
      }

      const link = await embed([
        { content: [{ type: 'image_url', image_url: { url: 'http://127.0.0.1:1/x.png' } }] },
      ])
      expect(link.status).toBe(400)
    }

    await core.embedding.unload()
  }, 600_000)
})
