import { describe, expect, it } from 'vitest'
import {
  GEMMA_MTP_DRAFT_FILENAMES,
  checkGemmaMtpSupport,
  gemmaMtpDraftUrl,
  resolveGemmaMtpDraft,
} from './gemma-mtp-registry.js'

describe('Gemma 4 MTP registry', () => {
  it.each([
    ['unsloth/gemma-4-31B-it-GGUF', 'am17an/Gemma4-31B-it-GGUF', 'mtp-gemma-4-31B-it.gguf'],
    ['gemma-4-31B-it-Q4_K_M', 'am17an/Gemma4-31B-it-GGUF', 'mtp-gemma-4-31B-it.gguf'],
    [
      'unsloth/gemma-4-26B-A4B-it-GGUF',
      'AtomicChat/gemma-4-26B-A4B-it-assistant-GGUF',
      'gemma-4-26B-A4B-it-assistant.Q8_0.gguf',
    ],
  ])('resolves %s to its draft head', (modelId, repo, draftFilename) => {
    const draft = resolveGemmaMtpDraft(modelId)
    expect(draft?.repo).toBe(repo)
    expect(draft?.draftFilename).toBe(draftFilename)
    expect(draft?.draftSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(draft?.draftSize).toBeGreaterThan(0)
    expect(checkGemmaMtpSupport(modelId)).toBe(true)
  })

  it.each([
    'gemma-4-12B-it-Q4_K_M',
    'gemma-4-E4B-it-Q4_K_M',
    'gemma-4-E2B-it',
    'gemma-4-26B-it',
    'Qwen3.6-27B',
  ])('does not resolve a head for %s', (modelId) => {
    expect(resolveGemmaMtpDraft(modelId)).toBeNull()
    expect(checkGemmaMtpSupport(modelId)).toBe(false)
  })

  it('returns a detached copy without the matcher', () => {
    const draft = resolveGemmaMtpDraft('gemma-4-31B-it')
    expect(draft).toEqual({
      repo: 'am17an/Gemma4-31B-it-GGUF',
      draftFilename: 'mtp-gemma-4-31B-it.gguf',
      draftSha256: '9514a3a9a5f36971580c83212f59ee681a5b9a09d597a6d14e40ecd12f76e8b9',
      draftSize: 514687200,
    })
    expect(draft).not.toHaveProperty('matches')
  })

  it('builds the Hugging Face resolve URL and lists every head filename', () => {
    const draft = resolveGemmaMtpDraft('gemma-4-31B-it')!
    expect(gemmaMtpDraftUrl(draft)).toBe(
      'https://huggingface.co/am17an/Gemma4-31B-it-GGUF/resolve/main/mtp-gemma-4-31B-it.gguf'
    )
    expect(GEMMA_MTP_DRAFT_FILENAMES).toEqual([
      'mtp-gemma-4-31B-it.gguf',
      'gemma-4-26B-A4B-it-assistant.Q8_0.gguf',
    ])
  })
})
