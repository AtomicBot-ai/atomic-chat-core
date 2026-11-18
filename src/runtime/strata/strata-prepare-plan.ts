import { strataCudaProfile } from '../../client/strata-contracts.js'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { parseStrataDescriptor } from '../../client/index.js'
import { AtomicCoreError, type StrataBackend } from '../../contracts/index.js'

export interface StrataPreparedOutput {
  path: string
  size?: number
  sha256?: string
}
export interface StrataPreparationStep {
  id: string
  tool:
    'tools/iq_pack.py' | 'tools/strata_tokenizer.py' | 'tools/dflash2_pack.py' | 'tools/dsv41/pack_gguf.py'
  args: string[]
  outputs: StrataPreparedOutput[]
}
export interface StrataPreparationPlan {
  steps: StrataPreparationStep[]
  gpuRequired: false
  readyPack?: true
}

/** Pinned local converters only. Source directories are never outputs and upstream setup is never invoked. */
export function strataPreparationPlan(
  raw: unknown,
  backend: StrataBackend,
  sourceDir: string,
  stagingDir: string
): StrataPreparationPlan {
  const d = parseStrataDescriptor(raw)
  const inside = (parent: string, child: string) => {
    const rest = relative(resolve(parent), resolve(child))
    return rest === '' || (!rest.startsWith('..') && !isAbsolute(rest))
  }
  if (
    !isAbsolute(sourceDir) ||
    !isAbsolute(stagingDir) ||
    inside(sourceDir, stagingDir) ||
    inside(stagingDir, sourceDir)
  )
    throw new AtomicCoreError(
      'INVALID_ARGUMENT',
      'Strata preparation requires disjoint absolute source and derivative directories.'
    )
  const source = (path: string) => join(sourceDir, path)
  const output = (path: string) => join(stagingDir, path)
  const tokenizer = [
    'pack/tokenizer/vocab.json',
    'pack/tokenizer/merges.txt',
    'pack/tokenizer/token_type.json',
    'pack/tokenizer/tokenizer.json',
    'pack/tokenizer/chat_template.jinja',
  ].map((path) => ({ path }))
  const profile = strataCudaProfile(d.variant_id)
  if (profile && backend !== 'cuda')
    throw new AtomicCoreError('MODEL_INCOMPATIBLE', 'The Strata preparation profile requires CUDA.')
  if (profile?.readyPack) return { gpuRequired: false, steps: [], readyPack: true }
  if (d.family === 'qwen36') {
    if (!['cuda', 'hip'].includes(backend) || (!profile && d.variant_id !== 'ud-q4-k-xl-mtp'))
      throw new AtomicCoreError('MODEL_INCOMPATIBLE', 'Unsupported Qwen3.6 preparation profile.')
    return {
      gpuRequired: false,
      steps: [
        {
          id: 'tokenizer',
          tool: 'tools/strata_tokenizer.py',
          args: ['--gguf', source(d.inputs.weights[0]!), '--out', output('pack')],
          outputs: tokenizer,
        },
      ],
    }
  }
  if (d.family === 'qwen38') {
    const sharedQuant = ['q2-0-dflash2', 'iq3-s-dflash2'].includes(d.variant_id)
    const additionalQuant =
      (backend === 'metal' && sharedQuant) ||
      (backend === 'cuda' && (sharedQuant || d.variant_id === 'iq2-xs-dflash2'))
    if (d.variant_id !== 'iq3-xxs-dflash2' && !additionalQuant && !profile)
      throw new AtomicCoreError('MODEL_INCOMPATIBLE', 'Unsupported Qwen3.8 preparation profile.')
    return {
      gpuRequired: false,
      steps: [
        {
          id: 'tokenizer',
          tool: 'tools/strata_tokenizer.py',
          args: ['--gguf', source(d.inputs.weights[0]!), '--out', output('pack')],
          outputs: tokenizer,
        },
        {
          id: 'model-pack',
          tool: 'tools/iq_pack.py',
          args: [
            '--gguf',
            source(d.inputs.weights[0]!),
            '--out',
            output('pack'),
            ...(backend === 'metal' ? [] : ['--experts-bin']),
            ...(/^(unsloth|gyro)-/.test(d.variant_id) ? ['--compat-bf16'] : []),
          ],
          outputs: [
            ...tokenizer,
            { path: 'pack/native_experts.txt' },
            { path: 'pack/index.txt' },
            { path: 'pack/dense.bin' },
            { path: 'pack/conversions.json' },
            ...(backend === 'metal' ? [] : [{ path: 'pack/experts.bin' }]),
          ],
        },
        ...(d.inputs.drafting === 'none'
          ? []
          : [
              {
                id: 'drafter',
                tool: 'tools/dflash2_pack.py' as const,
                args: [
                  source(d.inputs.drafter!),
                  source(d.inputs.drafter_config!),
                  output('draft.pack'),
                  '--q4_0',
                ],
                outputs: [
                  {
                    path: 'draft.pack',
                    size: 522458112,
                    sha256: 'cda40d62d0eb8f37ed6e272142641a1d2f0de4a32f9e14d0416e7a71534849f1',
                  },
                ],
              },
            ]),
      ],
    }
  }
  if (backend === 'sycl' || (!profile && d.variant_id !== 'ista-2-00bpw-dspark'))
    throw new AtomicCoreError('MODEL_INCOMPATIBLE', 'Unsupported DeepSeek preparation profile.')
  const expertProfile = d.files.find((f) => f.path === d.inputs.expert_profile)
  const draftArgs =
    d.inputs.drafting === 'dspark'
      ? [
          '--engram',
          source(d.inputs.engram!),
          '--engram-meta',
          source(d.inputs.engram_metadata!),
          '--dspark-gguf',
          source(d.inputs.drafter!),
          '--dspark-noise-token',
          '128799',
          '--dspark-markov-rank',
          '256',
        ]
      : []
  return {
    gpuRequired: false,
    steps: [
      {
        id: 'deepseek-pack',
        tool: 'tools/dsv41/pack_gguf.py',
        args: [
          '--model',
          sourceDir,
          '--shards',
          ...d.inputs.weights,
          ...draftArgs,
          '--mmproj',
          source(d.inputs.vision),
          // Disable upstream discovery of a sibling vision pack. The explicit GGUF supplies the geometry.
          '--vision',
          output('.tmp/unused-vision'),
          '--out',
          output('pack'),
        ],
        outputs: [
          ...tokenizer,
          { path: 'pack/ds4.txt' },
          { path: 'pack/tensors.txt' },
          { path: 'pack/engram.bin' },
          ...(expertProfile
            ? [{ path: 'pack/expert-profile.bin', size: expertProfile.size, sha256: expertProfile.sha256 }]
            : []),
        ],
      },
    ],
  }
}
