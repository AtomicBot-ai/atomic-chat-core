import { describe, expect, it } from 'vitest'
import { DEFAULT_MIGRATIONS, applyDefaultMigrations } from './default-migrations.js'
import { canonicalProviderDefaults } from './store.js'

describe('applyDefaultMigrations', () => {
  it('applies a migration only to the providers and the exact old value it names', () => {
    const providers: Record<string, unknown> = { vllm: { context_length: '8192' }, sglang: {} }
    const state: Record<string, unknown> = { default_migrations: ['sglang-auto-context', 7] }
    const outcome = applyDefaultMigrations(providers, state)
    // A hand-edited string is not the stored number 8192 (`canonicalize` runs before, in `open`).
    expect(providers['vllm']).toEqual({ context_length: '8192' })
    expect(outcome.moved).toEqual([])
    expect(outcome.recorded).not.toContain('sglang-auto-context')
    expect(state['default_migrations']).toEqual(
      expect.arrayContaining(['sglang-auto-context', 'vllm-auto-seqs'])
    )
  })

  it("moves each llama.cpp provider's old defaults and nothing it does not carry", () => {
    const providers: Record<string, unknown> = {
      'llamacpp-upstream': { parallel: 1, cont_batching: false, n_predict: -1 },
      'llamacpp': { parallel: 1 },
      'atomic-prism': { parallel: 8, n_predict: 0 },
    }
    const outcome = applyDefaultMigrations(providers, {})
    expect(providers).toEqual({
      'llamacpp-upstream': { parallel: 2, cont_batching: true, n_predict: 0 },
      'llamacpp': { parallel: 2 },
      'atomic-prism': { parallel: 8, n_predict: 0 },
    })
    expect(outcome.moved).toEqual([
      'llamacpp-upstream.parallel',
      'llamacpp.parallel',
      'llamacpp-upstream.cont_batching',
      'llamacpp-upstream.n_predict',
    ])
    expect(outcome.recorded).toEqual(DEFAULT_MIGRATIONS.map((m) => m.id))
  })

  it('moves every old default to exactly what the schema ships now', () => {
    for (const migration of DEFAULT_MIGRATIONS)
      for (const provider of migration.providers)
        expect(canonicalProviderDefaults(provider)[migration.key], `${provider}.${migration.key}`).toEqual(
          migration.to
        )
  })
})
