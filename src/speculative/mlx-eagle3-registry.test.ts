import { describe, expect, it } from 'vitest'
import { STATIC_EAGLE3_MAP, resolveEagle3Draft } from './mlx-eagle3-registry.js'

describe('resolveEagle3Draft', () => {
  it.each([
    ['mlx-community/gemma-4-31B-it-4bit', 'RedHatAI/gemma-4-31B-it-speculator.eagle3'],
    ['mlx-community/gemma-4-31B-it-bf16', 'RedHatAI/gemma-4-31B-it-speculator.eagle3'],
    ['gemma-4-26B-A4B-it', 'RedHatAI/gemma-4-26B-A4B-it-speculator.eagle3'],
  ])('resolves the target %s to %s', (modelId, repo) => {
    expect(resolveEagle3Draft(modelId)).toEqual({
      repo,
      required: ['config.json', 'model.safetensors'],
      optional: ['model.safetensors.index.json'],
    })
  })

  it('reverse-looks-up a fully-qualified speculator id without normalizing it', () => {
    expect(resolveEagle3Draft('RedHatAI/gemma-4-31B-it-speculator.eagle3')?.repo).toBe(
      'RedHatAI/gemma-4-31B-it-speculator.eagle3'
    )
    expect(resolveEagle3Draft('redhatai/GEMMA-4-26B-A4B-IT-SPECULATOR.EAGLE3')?.repo).toBe(
      'RedHatAI/gemma-4-26B-A4B-it-speculator.eagle3'
    )
    expect(resolveEagle3Draft('RedHatAI/unknown-speculator.eagle3')).toBeNull()
    expect(resolveEagle3Draft('someone/other.eagle3-4bit')).toBeNull()
  })

  it('has no head for the small Gemma 4 targets or other families', () => {
    expect(resolveEagle3Draft('mlx-community/gemma-4-E4B-it-4bit')).toBeNull()
    expect(resolveEagle3Draft('mlx-community/gemma-4-E2B-it-4bit')).toBeNull()
    expect(resolveEagle3Draft('mlx-community/Qwen3.6-27B-4bit')).toBeNull()
  })

  it('only lists the two large Gemma 4 targets', () => {
    expect(Object.keys(STATIC_EAGLE3_MAP).sort()).toEqual(['gemma-4-26b-a4b', 'gemma-4-31b'])
  })
})
