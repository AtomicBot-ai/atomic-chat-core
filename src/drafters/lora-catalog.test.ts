import { expect, it, vi } from 'vitest'
import { buildGguf } from '../../test/helpers/gguf-builder.js'
import { bundledLoras, catalogLoras, discoverLoras, hasLoraTensors } from './lora-catalog.js'
import catalog from '../client/model-catalog-baseline.json' with { type: 'json' }
it('projects only supported adapters with pinned provenance and exact target families', () => {
  const { files, families, sources } = catalogLoras(catalog)
  expect(sources.get('atomicchat/qwen3.8-27b-gguf')).toBe('Qwen/Qwen3.8-27B')
  expect(sources.get('unsloth/wan2.2-ti2v-5b-gguf')).toBe('Wan-AI/Wan2.2-TI2V-5B')
  expect(sources.get('unsloth/flux.2-klein-4b-gguf')).toBe('black-forest-labs/FLUX.2-klein-4B')
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
  expect(hasLoraTensors({ 'blocks.0.cross_attn.k.lora_A.default.weight': {} })).toBe(false)
  expect(hasLoraTensors({ 'diffusion_model.blocks.0.cross_attn.k.lora_A.weight': {} })).toBe(true)
  expect(hasLoraTensors({ 'diffusion_model.double_blocks.0.img_attn.proj.lora_A.weight': {} })).toBe(true)
})

it('reads bundled patches at a pinned revision and keeps the declared target of the standalone adapter', async () => {
  const repo = 'org/baked-GGUF'
  const sha = 'a'.repeat(40)
  const base = 'model/original'
  const adapter = buildGguf({ metadata: { 'general.type': 'adapter', 'adapter.type': 'lora' }, tensors: [] })
  const regular = buildGguf({ metadata: { 'general.type': 'model' }, tensors: [] })
  const request = async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    if (url.includes('/api/models/'))
      return Response.json({
        id: repo,
        sha,
        cardData: { base_model: base },
        siblings: ['base-Q8.gguf', 'patch/lora.gguf', 'fake-lora.gguf'].map((rfilename, i) => ({
          rfilename,
          lfs: { size: i === 1 ? adapter.length : regular.length, sha256: String(i).repeat(64) },
        })),
      })
    expect(url).toContain('/resolve/' + sha + '/')
    expect(url).not.toContain('base-Q8')
    return new Response(new Uint8Array(url.endsWith('fake-lora.gguf') ? regular : adapter))
  }
  const { results, partial } = await bundledLoras(request, repo)
  expect(partial).toBe(false)
  expect(results).toMatchObject([{ repo, target: base, file: 'patch/lora.gguf', revision: sha }])
})
