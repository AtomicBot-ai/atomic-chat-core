import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import { ModelRegistry } from './registry.js'
import { chooseDefaultHfFile, downloadHfModel, fetchHfGgufFiles, hfToken, looksLikeHfRepo } from './hf.js'

let data: TmpDataFolder

beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-hf-')
})
afterEach(() => data.cleanup())

describe('Hugging Face discovery', () => {
  it('recognises only safe owner/repository ids and applies token precedence', () => {
    expect(looksLikeHfRepo('AtomicChat/Qwen3.5-9B-GGUF')).toBe(true)
    for (const invalid of ['./local/path', '/abs/path', '~/home', 'nolash', 'too/many/parts', 'owner/..'])
      expect(looksLikeHfRepo(invalid)).toBe(false)
    expect(hfToken({ HF_TOKEN: 'preferred', HUGGING_FACE_HUB_TOKEN: 'legacy' })).toBe('preferred')
    expect(hfToken({ HF_TOKEN: ' ', HUGGING_FACE_HUB_TOKEN: 'legacy' })).toBe('legacy')
  })

  it('normalizes GGUF metadata, skips unsafe names, and sends the bearer token', async () => {
    let request: Request | undefined
    const fetchImpl: typeof fetch = async (input, init) => {
      request = new Request(input, init)
      return Response.json({
        siblings: [
          { rfilename: 'large.Q8_0.gguf', size: 800 },
          { rfilename: 'small.Q4_K_XL.gguf', lfs: { size: 400, sha256: 'abc' } },
          { rfilename: '../escape.gguf', size: 1 },
          { rfilename: '..\\escape.gguf', size: 1 },
          { rfilename: 'README.md', size: 2 },
        ],
      })
    }
    const files = await fetchHfGgufFiles('owner/repo', { fetch: fetchImpl, token: 'secret' })
    expect(request?.url).toContain('/api/models/owner/repo?blobs=true&files_metadata=true')
    expect(request?.headers.get('authorization')).toBe('Bearer secret')
    expect(files.map((file) => file.filename)).toEqual(['small.Q4_K_XL.gguf', 'large.Q8_0.gguf'])
    expect(files[0]).toMatchObject({ size: 400, sha256: 'abc' })
    expect(chooseDefaultHfFile(files).filename).toBe('small.Q4_K_XL.gguf')
    expect(chooseDefaultHfFile(files.filter((file) => !file.filename.includes('Q4_K_XL'))).filename).toBe(
      'large.Q8_0.gguf'
    )
  })

  it('turns gated and empty repositories into actionable errors', async () => {
    await expect(
      fetchHfGgufFiles('owner/gated', { fetch: async () => new Response('', { status: 403 }) })
    ).rejects.toMatchObject({ code: 'IO_ERROR', details: expect.stringContaining('HF_TOKEN') })
    await expect(
      fetchHfGgufFiles('owner/empty', { fetch: async () => Response.json({ siblings: [] }) })
    ).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' })
  })
})

describe('Hugging Face download', () => {
  it('validates the file before publishing model.yml in the shared app tree', async () => {
    const bytes = Buffer.from('a complete pretend gguf')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    let authorization: string | null = null
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      authorization = request.headers.get('authorization')
      return new Response(bytes, {
        status: 200,
        headers: { 'content-length': String(bytes.length) },
      })
    }
    const registry = new ModelRegistry(data.layout)
    await downloadHfModel({
      layout: data.layout,
      registry,
      repoId: 'owner/repo',
      file: {
        filename: 'model.Q4_K_XL.gguf',
        size: bytes.length,
        sha256,
        downloadUrl: 'https://huggingface.co/owner/repo/resolve/main/model.Q4_K_XL.gguf',
      },
      fetch: fetchImpl,
      env: { HF_TOKEN: 'secret' },
    })

    const model = await registry.get('owner/repo')
    expect(model.yml).toMatchObject({
      model_path: 'llamacpp/models/owner/repo/model.Q4_K_XL.gguf',
      model_size_bytes: bytes.length,
      model_sha256: sha256,
      embedding: false,
    })
    expect(authorization).toBe('Bearer secret')
    expect(await readFile(registry.resolvePaths(model.yml).modelPath)).toEqual(bytes)
  })

  it('does not publish model.yml when integrity validation fails', async () => {
    const bytes = Buffer.from('wrong')
    const registry = new ModelRegistry(data.layout)
    await expect(
      downloadHfModel({
        layout: data.layout,
        registry,
        repoId: 'owner/repo',
        file: {
          filename: 'model.gguf',
          size: bytes.length,
          sha256: '0'.repeat(64),
          downloadUrl: 'https://huggingface.co/file',
        },
        fetch: async () => new Response(bytes, { headers: { 'content-length': String(bytes.length) } }),
      })
    ).rejects.toThrow(/Hash verification/i)
    expect(await registry.find('owner/repo')).toBeUndefined()
  })
})
