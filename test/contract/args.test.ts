import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../src/contracts/index.js'
import type { LlamacppConfig } from '../../src/contracts/index.js'
import { buildLlamaArgs } from '../../src/runtime/llamacpp/args.js'
import { loadFixtureSet } from './fixtures.js'

interface ArgsInput {
  config: LlamacppConfig
  is_embedding: boolean
  model_id: string
  model_path: string
  port: number
  mmproj_path: string | null
}
type ArgsExpected = { argv: string[] } | { error: string }

/**
 * Deliberate divergences from the Rust builder these fixtures were emitted by (integrations audit
 * 2026-11-03): core sends `-kvu` whatever the slot count (S3: one KV pool shared by every slot), and
 * continuous batching both ways (P3: llama.cpp has it on unless sent `--no-cont-batching`). Compared
 * without those two tokens; that they are there is checked on its own, and where they go is pinned by
 * src/runtime/llamacpp/args.test.ts.
 */
const DIVERGENT = new Set(['-kvu', '--no-cont-batching'])
function withoutKnownDivergence(argv: string[]): string[] {
  return argv.filter((token) => !DIVERGENT.has(token))
}
function expectKnownDivergence(argv: string[], config: LlamacppConfig): void {
  expect(argv.filter((token) => token === '-kvu')).toHaveLength(1)
  const ik = (config.version_backend.split('/')[1] ?? '')
    .trim()
    .replace(/^\uFEFF/, '')
    .startsWith('ik')
  const batching = config.cont_batching || config.concurrent_mode
  expect(argv.includes('--no-cont-batching')).toBe(!batching && !ik)
}

for (const set of ['args', 'args-llamacpp']) {
  const { index, cases } = loadFixtureSet<ArgsInput, ArgsExpected>(set)

  describe(`contract: ${set} (${index.source.file} @ ${index.source.commit.slice(0, 7)}, ${index.comparator})`, () => {
    it('has every indexed case', () => {
      expect(cases.map((c) => c.name).sort()).toEqual([...index.cases].sort())
    })

    it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
      const provider = (c.source.provider ?? 'llamacpp-upstream') as 'llamacpp-upstream' | 'llamacpp'
      const run = () =>
        buildLlamaArgs(c.input.config, {
          provider,
          isEmbedding: c.input.is_embedding,
          modelId: c.input.model_id,
          modelPath: c.input.model_path,
          port: c.input.port,
          mmprojPath: c.input.mmproj_path,
        })
      if ('error' in c.expected) {
        try {
          run()
          expect.unreachable('expected an error')
        } catch (e) {
          expect(e).toBeInstanceOf(AtomicCoreError)
          expect((e as AtomicCoreError).code).toBe('INVALID_ARGUMENT')
          expect((e as AtomicCoreError).details).toBe(c.expected.error)
        }
      } else {
        const argv = run()
        expect(withoutKnownDivergence(argv)).toEqual(withoutKnownDivergence(c.expected.argv))
        expectKnownDivergence(argv, c.input.config)
      }
    })
  })
}
