import { describe, it, expect } from 'vitest'
import { buildGguf } from '../../test/helpers/gguf-builder.js'
import { DrafterDiscovery, quantizedFrom } from './catalog.js'

describe('Hugging Face DSpark evidence', () => {
  it('resolves only a single direct quantization, including a quantized fine-tune', () => {
    expect(quantizedFrom(['base_model:finetune:Qwen/Qwen3-4B'])).toBeUndefined()
    expect(quantizedFrom(['base_model:quantized:lab/finetune'])).toBe('lab/finetune')
    expect(quantizedFrom(['base_model:quantized:a/b', 'base_model:quantized:b/c'])).toBeUndefined()
  })
  it('inspects the pinned GGUF tensor table and excludes other targets in a mixed repository', async () => {
    const source = 'lab/mixed'
    const target = 'Qwen/Qwen3-4B'
    const names = ['dspark-4B-Q8_0.gguf', 'dspark-4B-fake.gguf', 'dspark-8B-F16.gguf']
    const info = {
      sha: '1'.repeat(40),
      cardData: {
        dspark_targets: Object.fromEntries(
          names.map((name, i) => [name, i === 2 ? 'Qwen/Qwen3-8B' : target])
        ),
      },
      siblings: names.map((rfilename, i) => ({
        rfilename,
        size: 100,
        lfs: { sha256: String(i).repeat(64) },
      })),
    }
    const inspect = async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.includes('/api/models?')) return Response.json([])
      if (url.includes('/api/models/' + source)) return Response.json(info)
      if (url.endsWith('config.json')) return new Response(null, { status: 404 })
      expect(url).toContain('/resolve/' + info.sha + '/')
      const file = buildGguf({
        metadata: { 'general.architecture': 'dflash' },
        tensors: (url.includes('fake') ? [] : ['markov_w1.weight', 'markov_w2.weight']).map((name) => ({
          name,
          type: 0,
          dims: [2],
          bitsPerWeight: 32,
        })),
      })
      return new Response(new Uint8Array(file), { status: 206 })
    }
    const result = await new DrafterDiscovery(inspect).search(target, source)
    expect(result.results.map((row) => row.file)).toEqual([names[0]])
  })
  it('discovers co-published GGUF heads by search and tag, resolves array ancestry, and expands only verified variants', async () => {
    const repo = 'publisher/Inkling-2-Mini-GGUF'
    const target = 'thinkingmachines/Inkling-2-Mini'
    const names = [
      'dspark-Inkling-2-Mini-Q8_0.gguf',
      'dspark/dspark-Inkling-2-Mini-BF16-mainline.gguf_file',
      'dspark-Inkling-2-Mini-Tuned-F16.gguf',
      'Inkling-2-Mini-Q4.gguf',
    ]
    const file = buildGguf({
      metadata: { 'general.architecture': 'dflash' },
      tensors: ['markov_w1.weight', 'markov_w2.weight'].map((name) => ({
        name,
        type: 0,
        dims: [2],
        bitsPerWeight: 32,
      })),
    })
    const inspected: string[] = []
    const mock = async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/models')
        return Response.json(url.searchParams.get('filter') === 'gguf,dspark' ? [{ id: repo }] : [])
      if (url.pathname.startsWith('/api/models/'))
        return Response.json({
          sha: 'a'.repeat(40),
          tags: ['base_model:quantized:' + target],
          cardData: { base_model: [target] },
          siblings: names.map((rfilename, i) => ({
            rfilename,
            size: file.length,
            lfs: { sha256: String(i).repeat(64) },
          })),
        })
      inspected.push(url.pathname)
      return new Response(new Uint8Array(file), { status: 206 })
    }
    const discovery = new DrafterDiscovery(mock)
    expect((await discovery.search()).results).toMatchObject([{ file: names[0], target, moreVariants: true }])
    expect(inspected).toHaveLength(1)
    expect((await discovery.search(target, repo)).results.map((d) => d.file).sort()).toEqual(
      names.slice(0, 2).sort()
    )
    expect(inspected).toHaveLength(2)
    expect((await discovery.search(undefined, undefined, 'BF16')).results.map((d) => d.quant)).toEqual([
      'BF16',
    ])
    expect((await discovery.search('other/Inkling-2-Mini', repo)).results).toEqual([])
  })
})

it('checks a pinned model repo before feeds and only returns its documented, verified head', async () => {
  const source = 'publisher/baked-GGUF'
  const revision = 'a'.repeat(40)
  const file = buildGguf({
    metadata: { 'general.architecture': 'dflash' },
    tensors: ['markov_w1.weight', 'markov_w2.weight'].map((name) => ({
      name,
      type: 0,
      dims: [2],
      bitsPerWeight: 32,
    })),
  })
  const inspected: string[] = []
  const request = async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    inspected.push(url)
    if (url.includes('/api/models?')) throw new Error('feed offline')
    if (url.includes('/api/models/'))
      return Response.json({
        sha: revision,
        cardData: { base_model: 'org/original' },
        siblings: ['base.gguf', 'heads/dspark-Q8_0.gguf', 'other/dspark-Q8_0.gguf', 'README.md'].map(
          (rfilename, i) => ({
            rfilename,
            size: file.length,
            lfs: { sha256: String(i).repeat(64) },
          })
        ),
      })
    if (url.endsWith('/README.md'))
      return new Response('llama-server -m ./base.gguf --model-draft ./heads/dspark-Q8_0.gguf')
    return new Response(new Uint8Array(file))
  }
  const result = await new DrafterDiscovery(request).search(source, source)
  expect(result.results.map((r) => [r.repo, r.file, r.target])).toEqual([
    [source, 'heads/dspark-Q8_0.gguf', source],
  ])
  expect(result.partial).toBe(true)
  expect(
    inspected.findIndex((url) => url.endsWith('/resolve/' + revision + '/heads/dspark-Q8_0.gguf'))
  ).toBeLessThan(inspected.findIndex((url) => url.includes('/api/models?')))
})
