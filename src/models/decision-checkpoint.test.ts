import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { inspectDecisionModelPath, isDecisionCheckpointDir } from './decision-checkpoint.js'
import { DECISION_CHECKPOINT_FILES, missingDecisionCheckpointFiles } from './gguf/index.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'atomic-decision-ckpt-'))
})
afterEach(() => rm(root, { recursive: true, force: true }))

async function checkpoint(files: readonly string[]): Promise<string> {
  const dir = join(root, 'laya-multilingual')
  for (const file of files) {
    const path = join(dir, ...file.split('/'))
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, '{}')
  }
  await mkdir(dir, { recursive: true })
  return dir
}

describe('missingDecisionCheckpointFiles', () => {
  it('lists the required files a folder lacks, in a stable order', () => {
    expect(missingDecisionCheckpointFiles(new Set(DECISION_CHECKPOINT_FILES))).toEqual([])
    expect(missingDecisionCheckpointFiles(new Set(['rl_agent_config.json', 'encoder/config.json']))).toEqual([
      'tokenizer/tokenizer.json',
      'model.safetensors',
    ])
  })
})

describe('inspectDecisionModelPath', () => {
  it('tells a GGUF file, a complete checkpoint folder, an incomplete one and nothing apart', async () => {
    const gguf = join(root, 'laya.gguf')
    await writeFile(gguf, 'GGUF')
    expect(await inspectDecisionModelPath(gguf)).toEqual({ kind: 'file' })
    expect(await inspectDecisionModelPath(join(root, 'missing'))).toEqual({ kind: 'none' })

    const dir = await checkpoint(DECISION_CHECKPOINT_FILES)
    expect(await inspectDecisionModelPath(dir)).toEqual({ kind: 'checkpoint-dir', missing: [] })
    await rm(join(dir, 'model.safetensors'))
    expect(await inspectDecisionModelPath(dir)).toEqual({
      kind: 'checkpoint-dir',
      missing: ['model.safetensors'],
    })
  })
})

describe('isDecisionCheckpointDir', () => {
  it('recognises a laya folder by rl_agent_config.json, complete or not', async () => {
    expect(await isDecisionCheckpointDir(await checkpoint(['rl_agent_config.json']))).toBe(true)
  })

  it('does not take another folder or a file for one', async () => {
    expect(await isDecisionCheckpointDir(await checkpoint(['encoder/config.json']))).toBe(false)
    const gguf = join(root, 'model.gguf')
    await writeFile(gguf, 'GGUF')
    expect(await isDecisionCheckpointDir(gguf)).toBe(false)
  })
})
