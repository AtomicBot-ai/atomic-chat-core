import { expect, it, vi } from 'vitest'
import { catalogLoras, discoverLoras, hasLoraTensors } from './lora-catalog.js'
import catalog from '../client/model-catalog-baseline.json' with { type: 'json' }
it('projects only supported adapters with pinned provenance and exact target families', () => {
  const { files, families } = catalogLoras(catalog)
  expect(new Set(files.map((f) => f.mode))).toEqual(new Set(['chat', 'image', 'video']))
  expect(families.get('video:wan2.2-ti2v-5b')).toBe('Wan-AI/Wan2.2-TI2V-5B')
  expect(
    catalogLoras({
      models: {
        bad: {
          kind: 'auxiliary',
          format: 'gguf',
          variants: {},
          definition: { method: 'lora', target: 'A/B', repo: 'A/C', revision: 'main', modality: 'chat' },
          files: [{ size: 10, path: 'x.gguf', sha256: 'a'.repeat(64) }],
        },
      },
    }).files
  ).toEqual([])
})
it('discovers a pinned media adapter only for its declared base model', async () => {
  const sha = 'a'.repeat(40)
  const publication = {
    id: 'org/sprites',
    sha,
    tags: ['text-to-image', 'lora'],
    cardData: { base_model: ['org/flux'] },
    siblings: [{ rfilename: 'sprites.safetensors', lfs: { size: 100, sha256: '1'.repeat(64) } }],
  }
  const header = Buffer.from(JSON.stringify({ 'transformer.lora_A.weight': {} }))
  const prefix = Buffer.alloc(8)
  prefix.writeBigUInt64LE(BigInt(header.length))
  const request = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
    if (String(url).includes('/resolve/')) return new Response(Buffer.concat([prefix, header]))
    return Response.json(String(url).includes('/revision/') ? publication : [publication])
  })
  expect((await discoverLoras(request, 'sprites', 'org/flux')).results).toMatchObject([
    { repo: 'org/sprites', mode: 'image', target: 'org/flux', revision: sha },
  ])
  expect((await discoverLoras(request, 'sprites', 'org/other')).results).toEqual([])
})

it('only offers FLUX LoRA blocks that the media backend can address', () => {
  expect(hasLoraTensors({ 'base_model.model.double_blocks.0.img_attn.proj.lora_A.weight': {} })).toBe(false)
  expect(hasLoraTensors({ 'diffusion_model.double_blocks.0.img_attn.proj.lora_A.weight': {} })).toBe(true)
})
