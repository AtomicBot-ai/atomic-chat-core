import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildGguf } from '../../../../test/helpers/gguf-builder.js'
import {
  bundleChip,
  GeniexInspectError,
  inspectBundle,
  inspectGeniexModel,
  inspectGgufFile,
} from './inspect.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-geniex-inspect-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const gguf = (metadata: Record<string, string | number | boolean>) =>
  buildGguf({
    metadata,
    tensors: [{ name: 'token_embd.weight', type: 2, dims: [64, 8], bitsPerWeight: 4.5 }],
  })

describe('inspectGgufFile (task 5.2)', () => {
  it('reads the architecture, context length, quantization and chat template from the header', async () => {
    const file = join(dir, 'Qwen3-4B-Q4_0.gguf')
    await writeFile(
      file,
      gguf({
        'general.architecture': 'qwen3',
        'general.file_type': 2,
        'qwen3.context_length': 40960,
        'tokenizer.chat_template': '{% for message in messages %}…{% endfor %}',
      })
    )
    expect(await inspectGgufFile(file)).toEqual({
      kind: 'gguf',
      architecture: 'qwen3',
      max_context_tokens: 40960,
      quantization: 'Q4_0',
      chat_template: true,
      vision: false,
    })
  })

  it('sees vision in an mmproj beside the file, and leaves null what the header lacks', async () => {
    const file = join(dir, 'gemma-4-E2B-it-Q4_0.gguf')
    await writeFile(file, gguf({ 'general.architecture': 'gemma4', 'general.file_type': 15 }))
    await writeFile(join(dir, 'mmproj-F16.gguf'), 'projector')
    expect(await inspectGgufFile(file)).toEqual({
      kind: 'gguf',
      architecture: 'gemma4',
      max_context_tokens: null,
      quantization: 'Q4_K_M',
      chat_template: false,
      vision: true,
    })
  })

  it('refuses a file that is not a GGUF, naming why', async () => {
    const file = join(dir, 'cut.gguf')
    await writeFile(file, 'GGUF but cut')
    await expect(inspectGgufFile(file)).rejects.toBeInstanceOf(GeniexInspectError)
    await expect(inspectGgufFile(join(dir, 'missing.gguf'))).rejects.toThrow(/cannot be read|does not exist/)
    await writeFile(join(dir, 'text.gguf'), 'not a gguf at all, just text that is long enough to read')
    await expect(inspectGgufFile(join(dir, 'text.gguf'))).rejects.toThrow(/not a GGUF file/)
  })
})

describe('inspectBundle', () => {
  it('reads the chip, context, precision and minimal GenieX version of geniex.json, in the spellings AI Hub uses', async () => {
    const bundle = join(dir, 'qwen3-4b-x-elite')
    await mkdir(bundle)
    await writeFile(
      join(bundle, 'geniex.json'),
      JSON.stringify({
        model: 'Qwen3-4B',
        chipset: 'qualcomm-snapdragon-x-elite',
        context_length: 4096,
        precision: 'w4a16',
        min_runtime_version: '0.9.3',
        shards: ['model.bin'],
      })
    )
    expect(await inspectBundle(bundle)).toEqual({
      kind: 'qairt',
      chip: 'x-elite',
      max_context_tokens: 4096,
      precision: 'w4a16',
      min_runtime_version: '0.9.3',
    })
    expect(await inspectGeniexModel(bundle)).toMatchObject({ kind: 'qairt' })
  })

  it('leaves null what the bundle does not say, and refuses a folder without geniex.json', async () => {
    const bundle = join(dir, 'bare')
    await mkdir(bundle)
    await writeFile(join(bundle, 'geniex.json'), JSON.stringify({ model: 'x' }))
    expect(await inspectBundle(bundle)).toEqual({
      kind: 'qairt',
      chip: null,
      max_context_tokens: null,
      precision: null,
      min_runtime_version: null,
    })
    await mkdir(join(dir, 'empty'))
    await expect(inspectBundle(join(dir, 'empty'))).rejects.toThrow(/not an AI Hub bundle/)
    await expect(inspectGeniexModel(join(dir, 'nowhere'))).rejects.toThrow(/does not exist/)
  })

  it('names the chip from AI Hub spellings', () => {
    expect(bundleChip('qualcomm-snapdragon-x-elite')).toBe('x-elite')
    expect(bundleChip('Snapdragon X2 Elite')).toBe('x2-elite')
    expect(bundleChip('x2-elite')).toBe('x2-elite')
    expect(bundleChip('X1E80100')).toBe('x-elite')
    expect(bundleChip('qualcomm-snapdragon-8-elite')).toBeNull()
    expect(bundleChip(7)).toBeNull()
  })
})
