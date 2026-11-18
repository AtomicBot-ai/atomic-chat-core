import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { AtomicCoreError } from '../../src/contracts/index.js'
import catalog from '../fixtures/strata/catalog.json' with { type: 'json' }
import { parseStrataDescriptor } from '../../src/client/index.js'
import { strataPreparationPlan } from '../../src/runtime/strata/strata-prepare-plan.js'
import { runStrataPreparationStep } from '../../src/runtime/strata/index.js'
import { buildGguf } from '../helpers/gguf-builder.js'
import type { GgufMetaValue } from '../helpers/gguf-builder.js'

const bundle = process.env.ATOMIC_TEST_STRATA_TREE
const descriptors = Object.values(catalog.models).map((m) => parseStrataDescriptor(m.definition))
const tensor = (name: string, dims = [32, 2]) => ({ name, dims, type: 0, bitsPerWeight: 32 })
const tokenizer = {
  'tokenizer.ggml.model': 'gpt2',
  'tokenizer.ggml.pre': 'qwen35',
  'tokenizer.ggml.tokens': { strings: ['a', 'b', 'ab', '<｜deepseek_image｜>'] },
  'tokenizer.ggml.merges': { strings: ['a b'] },
  'tokenizer.chat_template': '{{ messages[0].content }}',
}
async function useFixture(
  work: (src: string, stage: string, put: (name: string, content: Buffer) => Promise<void>) => Promise<void>
) {
  const root = await mkdtemp(join(tmpdir(), 'strata-recipe-'))
  const source = join(root, 'source'),
    stage = join(root, 'stage')
  await mkdir(stage)
  const inputs = new Map<string, Buffer>()
  try {
    await work(source, stage, async (name, content) => {
      const path = join(source, name)
      inputs.set(path, content)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content)
    })
    for (const [path, initial] of inputs) expect(await readFile(path)).toEqual(initial)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
const run = (stage: string, step: Parameters<typeof runStrataPreparationStep>[1]) =>
  runStrataPreparationStep(
    {
      python: join(
        bundle!,
        process.platform === 'win32' ? 'control/python/python.exe' : 'control/python/bin/python3'
      ),
      controlDir: join(bundle!, 'control'),
      stagingDir: stage,
      platform: process.platform,
      env: {},
    },
    step,
    new AbortController().signal
  )

it.skipIf(!bundle)(
  'converts split Qwen3.8 with the pinned local tokenizer, packer and DFlash2 converter',
  async () => {
    const d = descriptors[0]!
    await useFixture(async (src, stage, put) => {
      const split = (n: number) => ({
        'general.architecture': 'qwen4exp',
        'split.count': 2,
        'split.no': n,
        'split.tensors.count': 6,
      })
      await put(
        d.inputs.weights[0]!,
        buildGguf({
          metadata: { ...split(0), ...tokenizer },
          tensors: [
            tensor('blk.0.ffn_gate_inp.weight'),
            tensor('blk.0.ffn_gate_exps.weight', [32, 2, 2]),
            tensor('blk.0.ffn_up_exps.weight', [32, 2, 2]),
            tensor('token_embd.weight'),
          ],
        })
      )
      await put(
        d.inputs.weights[1]!,
        buildGguf({
          metadata: split(1),
          tensors: [tensor('blk.0.ffn_down_exps.weight', [32, 2, 2]), tensor('blk.1.ple_key.weight')],
        })
      )
      const names = [
        'fc.weight',
        'hidden_norm.weight',
        'norm.weight',
        'candidate_selector.hidden_projection.weight',
        'candidate_selector.predecessor_codebook',
        'candidate_selector.successor_codebook',
      ]
      const header = Buffer.from(
        JSON.stringify(
          Object.fromEntries(
            names.map((name, index) => [
              name,
              { dtype: 'BF16', shape: [1, 32], data_offsets: [64 * index, 64 * (index + 1)] },
            ])
          )
        )
      )
      const count = Buffer.alloc(8)
      count.writeBigUInt64LE(BigInt(header.length))
      await put(d.inputs.drafter!, Buffer.concat([count, header, Buffer.alloc(64 * names.length)]))
      await put(
        d.inputs.drafter_config!,
        Buffer.from(
          JSON.stringify({
            hidden_size: 32,
            num_hidden_layers: 0,
            num_attention_heads: 1,
            num_key_value_heads: 1,
            head_dim: 32,
            intermediate_size: 32,
            sliding_window: 32,
            rope_parameters: { rope_theta: 10000 },
            rms_norm_eps: 0.00001,
            vocab_size: 4,
            dflash_config: {
              block_size: 2,
              conv_group_size: 1,
              conv_kernel_size: 1,
              mask_token_id: 0,
              selector_rank: 1,
              selector_top_k: 1,
              target_layer_ids: [0],
            },
          })
        )
      )
      const plan = strataPreparationPlan(d, 'cuda', src, stage)
      await run(stage, plan.steps[0]!)
      const secondShard = join(src, d.inputs.weights[1]!)
      await rename(secondShard, secondShard + '.missing')
      try {
        await expect(run(stage, plan.steps[1]!)).rejects.toThrow()
      } finally {
        await rename(secondShard + '.missing', secondShard)
      }
      await run(stage, plan.steps[1]!)
      await run(stage, plan.steps[2]!)
      const index = await readFile(join(stage, 'pack/native_experts.txt'), 'utf8')
      expect(index).toContain('v4:')
      expect(index).toContain(d.inputs.weights[1])
      expect((await readFile(join(stage, 'pack/experts.bin'))).byteLength).toBe(1536)
      expect((await readFile(join(stage, 'draft.pack'))).subarray(0, 4).toString()).toBe('DF2P')
    })
  }
)

it.skipIf(!bundle)(
  'indexes four DeepSeek shards, the external Engram, DSpark and vision without copying the weights',
  async () => {
    const d = descriptors[2]!
    await useFixture(async (src, stage, put) => {
      const meta: Record<string, GgufMetaValue> = {
        'deepseek41.attention.output_group_count': 1,
        'deepseek41.expert_used_count': 6,
        'deepseek41.engram.layers': { uints: [0] },
        'deepseek41.engram.max_ngram_size': 2,
        'deepseek41.engram.head_count': 1,
        'deepseek41.engram.head_dim': 2,
        'deepseek41.engram.token_map': { uints: [0, 1, 2, 3] },
        'deepseek41.engram.multipliers': { uints: [1, 3] },
        'deepseek41.engram.primes': { uints: [7] },
        'deepseek41.engram.offsets': { uints: [0] },
        'deepseek41.engram.pad_token_id': 0,
      }
      const trunk = [
        'token_embd.weight',
        'blk.0.engram_kv.weight',
        'blk.0.engram_gate.weight',
        'output.weight',
      ]
      for (const [n, name] of d.inputs.weights.entries())
        await put(
          name,
          buildGguf({
            metadata: {
              'general.architecture': 'deepseek41',
              'split.count': 4,
              'split.no': n,
              ...(n === 0
                ? {
                    ...tokenizer,
                    'deepseek41.attention.output_group_count': 1,
                    'deepseek41.expert_used_count': 6,
                  }
                : {}),
            },
            tensors: [tensor(trunk[n]!, [32, 4])],
          })
        )
      await put(d.inputs.engram_metadata!, buildGguf({ metadata: meta, tensors: [] }))
      await put(
        d.inputs.engram!,
        buildGguf({
          metadata: { 'general.architecture': 'deepseek41-engram' },
          tensors: [tensor('blk.0.engram_embd.weight')],
        })
      )
      await put(
        d.inputs.drafter!,
        buildGguf({
          metadata: { 'general.architecture': 'dflash', 'dflash.block_count': 1 },
          tensors: [tensor('fc.weight')],
        })
      )
      await put(
        d.inputs.vision,
        buildGguf({
          metadata: {
            'general.architecture': 'clip',
            'clip.projector_type': 'deepseek41v',
            'clip.vision.block_count': 1,
          },
          tensors: [tensor('v.patch_embd.weight')],
        })
      )
      await put(
        '../vision/vision.json',
        Buffer.from(
          JSON.stringify({
            config: { 'vision.num_hidden_layers': 999 },
            tensors: [],
          })
        )
      )
      await put('../vision/vision.bin', Buffer.from('foreign artifact'))
      const plan = strataPreparationPlan(d, 'metal', src, stage)
      await run(stage, plan.steps[0]!).catch((error: unknown) => {
        if (error instanceof AtomicCoreError) throw new Error(error.message + ': ' + error.details)
        throw error
      })
      const index = await readFile(join(stage, 'pack/tensors.txt'), 'utf8')
      for (const path of [...d.inputs.weights, d.inputs.engram, d.inputs.drafter, d.inputs.vision])
        expect(index).toContain(path)
      expect(index).toContain('mtp.0.main_proj.weight')
      expect(index).toContain('vision.patch_embed.proj.weight')
      expect(index).not.toContain('../vision/vision.bin')
      expect(await readFile(join(stage, 'pack/ds4.txt'), 'utf8')).toContain('vision.num_hidden_layers 1')
      expect((await readFile(join(stage, 'pack/engram.bin'))).subarray(0, 4).toString()).toBe('DSE1')
      expect(await readFile(join(stage, 'pack/ds4.txt'), 'utf8')).toContain('num_experts_per_tok 6')
    })
  }
)
