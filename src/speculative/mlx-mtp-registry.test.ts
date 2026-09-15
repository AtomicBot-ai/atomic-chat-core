import { describe, expect, it } from 'vitest'
import { STATIC_MTP_MAP, resolveMtpDraft } from './mlx-mtp-registry.js'

describe('resolveMtpDraft', () => {
  it.each([
    ['mlx-community/gemma-4-E2B-it-bf16', 'mlx-community/gemma-4-E2B-it-assistant-bf16'],
    ['mlx-community/gemma-4-31B-it-8bit', 'mlx-community/gemma-4-31B-it-assistant-bf16'],
    ['mlx-community/Qwen3.5-4B-4bit', 'mlx-community/Qwen3.5-4B-MTP-bf16'],
    ['mlx-community/Qwen3.5-9B-MLX-bf16', 'mlx-community/Qwen3.5-9B-MTP-bf16'],
    ['mlx-community/Qwen3.6-27B-4bit', 'mlx-community/Qwen3.6-27B-MTP-bf16'],
    ['mlx-community/Qwen3.6-35B-A3B-4bit', 'mlx-community/Qwen3.6-35B-A3B-MTP-bf16'],
    ['mlx-community/DeepSeek-V4-Flash-4bit', 'mlx-community/DeepSeek-V4-Flash-MTP-bf16'],
  ])('resolves the target %s to %s', (modelId, repo) => {
    expect(resolveMtpDraft(modelId)).toEqual({
      repo,
      required: ['config.json', 'model.safetensors'],
      optional: ['model.safetensors.index.json'],
    })
  })

  it('reverse-looks-up a fully-qualified drafter id without normalizing it', () => {
    expect(resolveMtpDraft('mlx-community/gemma-4-E4B-it-assistant-bf16')?.repo).toBe(
      'mlx-community/gemma-4-E4B-it-assistant-bf16'
    )
    expect(resolveMtpDraft('MLX-COMMUNITY/QWEN3.6-27B-MTP-BF16')?.repo).toBe(
      'mlx-community/Qwen3.6-27B-MTP-bf16'
    )
    expect(resolveMtpDraft('someone/other-assistant-bf16')).toBeNull()
    expect(resolveMtpDraft('someone/other-MTP')).toBeNull()
  })

  it('returns null for targets without an MTP pairing', () => {
    expect(resolveMtpDraft('mlx-community/gemma-4-12B-it-4bit')).toBeNull()
    expect(resolveMtpDraft('mlx-community/Qwen3-4B-4bit')).toBeNull()
    expect(resolveMtpDraft('gpt-oss-20b')).toBeNull()
  })

  it('lists nine canonical pairings', () => {
    expect(Object.keys(STATIC_MTP_MAP)).toHaveLength(9)
  })
})
