import { describe, expect, it } from 'vitest'
import { chooseDefaultHfFile, fetchHfGgufFiles, hfToken, looksLikeHfRepo } from './hf.js'

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
