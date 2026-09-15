import { describe, expect, it } from 'vitest'
import {
  TRANSCRIPTION_IDLE_UNLOAD_MS,
  TRANSCRIPTION_LOAD_OVERRIDES,
  TRANSCRIPTION_MMPROJ_BYTES,
  TRANSCRIPTION_MMPROJ_URL,
  TRANSCRIPTION_MODEL_BYTES,
  TRANSCRIPTION_MODEL_HF_REPO,
  TRANSCRIPTION_MODEL_ID,
  TRANSCRIPTION_MODEL_URL,
  TRANSCRIPTION_TOTAL_BYTES,
  VOXTRAL_TRANSCRIPTION_CHAT_TEMPLATE,
} from './transcription-registry.js'

describe('transcription registry', () => {
  it('pins the Voxtral model, its repo and both download URLs', () => {
    expect(TRANSCRIPTION_MODEL_ID).toBe('ggml-org/Voxtral-Mini-3B-2507-Q4_K_M')
    expect(TRANSCRIPTION_MODEL_HF_REPO).toBe('ggml-org/Voxtral-Mini-3B-2507-GGUF')
    expect(TRANSCRIPTION_MODEL_URL).toBe(
      'https://huggingface.co/ggml-org/Voxtral-Mini-3B-2507-GGUF/resolve/main/Voxtral-Mini-3B-2507-Q4_K_M.gguf'
    )
    expect(TRANSCRIPTION_MMPROJ_URL).toBe(
      'https://huggingface.co/ggml-org/Voxtral-Mini-3B-2507-GGUF/resolve/main/mmproj-Voxtral-Mini-3B-2507-Q8_0.gguf'
    )
  })

  it('reports the exact total size for the progress bar', () => {
    expect(TRANSCRIPTION_MODEL_BYTES).toBe(2_473_001_920)
    expect(TRANSCRIPTION_MMPROJ_BYTES).toBe(715_714_080)
    expect(TRANSCRIPTION_TOTAL_BYTES).toBe(TRANSCRIPTION_MODEL_BYTES + TRANSCRIPTION_MMPROJ_BYTES)
  })

  it('forces the transcription chat template and small deterministic load overrides', () => {
    expect(VOXTRAL_TRANSCRIPTION_CHAT_TEMPLATE).toContain("'[INST]' + content.text + '[TRANSCRIBE]'")
    expect(VOXTRAL_TRANSCRIPTION_CHAT_TEMPLATE).not.toContain('[/INST]')
    expect(TRANSCRIPTION_LOAD_OVERRIDES).toEqual({
      fit: false,
      ctx_size: 4096,
      n_predict: 512,
      parallel: 1,
      cont_batching: false,
      chat_template: VOXTRAL_TRANSCRIPTION_CHAT_TEMPLATE,
      extra_args: '--no-warmup',
    })
    expect(TRANSCRIPTION_IDLE_UNLOAD_MS).toBe(5 * 60_000)
  })
})
