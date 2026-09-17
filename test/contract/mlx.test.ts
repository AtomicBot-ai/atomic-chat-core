import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ErrorBody } from '../../src/contracts/index.js'
import { buildMlxServerArgs, classifyMlxStderr } from '../../src/runtime/mlx/index.js'
import type { MlxServerConfig } from '../../src/runtime/mlx/index.js'
import { loadFixtureSet } from './fixtures.js'

interface ArgsInput {
  model_path: string
  port: number
  config: MlxServerConfig
}

const args = loadFixtureSet<ArgsInput, { argv: string[] }>('mlx-args')
const errors = loadFixtureSet<{ stderr: string }, ErrorBody>('mlx-errors')

let tmp: string
beforeAll(async () => {
  // The emitter's <tmp> held target/model.safetensors and draft/model.safetensors as real files.
  tmp = await mkdtemp(join(tmpdir(), 'atomic-mlx-contract-'))
  for (const dir of ['target', 'draft']) {
    await mkdir(join(tmp, dir), { recursive: true })
    await writeFile(join(tmp, dir, 'model.safetensors'), 'x')
  }
})
afterAll(() => rm(tmp, { recursive: true, force: true }))

const real = (value: string) => value.replaceAll('<tmp>', tmp)
const placeholder = (value: string) => value.replaceAll(tmp, '<tmp>')

describe(`contract: mlx args (${args.index.source.file} @ ${args.index.source.commit.slice(0, 7)}, ${args.index.comparator})`, () => {
  it('has every indexed case', () => {
    expect(args.cases.map((c) => c.name).sort()).toEqual([...args.index.cases].sort())
  })

  it.each(args.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const config = { ...c.input.config, draft_model_path: real(c.input.config.draft_model_path) }
    const argv = buildMlxServerArgs(real(c.input.model_path), c.input.port, config).map(placeholder)
    expect(argv).toEqual(c.expected.argv)
  })
})

describe(`contract: mlx errors (${errors.index.source.file} @ ${errors.index.source.commit.slice(0, 7)})`, () => {
  it('has every indexed case', () => {
    expect(errors.cases.map((c) => c.name).sort()).toEqual([...errors.index.cases].sort())
  })

  it.each(errors.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(classifyMlxStderr(c.input.stderr).toJSON()).toEqual(c.expected)
  })
})
