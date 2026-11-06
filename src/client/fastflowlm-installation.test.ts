import { expect, it } from 'vitest'
import candidate from '../../test/fixtures/fastflowlm/qwen3-candidate.json' with { type: 'json' }
import { buildFastFlowLmConfig, parseFastFlowLmDescriptor } from './fastflowlm-installation.js'

it('builds one local Qwen3 catalog with the native model format floor and exact installer file paths', () => {
  const descriptor = parseFastFlowLmDescriptor(candidate.definition)
  const { modelList, modelInfo } = buildFastFlowLmConfig(descriptor)
  expect(modelList.model_path).toBe('.')
  expect(modelList.models.qwen3?.['0.6b']).toMatchObject({
    name: descriptor.variant_id,
    size: 600000000,
    flm_min_version: '0.9.22',
    max_prefill_len: 4096,
    default_context_length: 32768,
    files: descriptor.files.map((f) => f.path),
  })
  expect(modelInfo[descriptor.checkpoint]).toEqual(
    descriptor.files.map(({ path, size, sha256 }) => ({ type: 'file', path, size, sha256 }))
  )
  expect(JSON.stringify({ modelList, modelInfo })).not.toMatch(/https?:|preferred_source/)
})

it('requires portable paths, complete kernel inventory, immutable sources and bounded context', () => {
  const d = parseFastFlowLmDescriptor(candidate.definition)
  for (const change of [
    { capabilities: { ...d.capabilities, tools: true } },
    { variant_id: '../x' },
    { variant_id: 'con.txt' },
    { files: d.files.filter((f) => f.path !== 'lm_head.xclbin') },
    { files: [{ ...d.files[0], path: 'x/../out' }, ...d.files.slice(1)] },
    { files: [{ ...d.files[0], path: 'flm/model_info.json' }, ...d.files.slice(1)] },
    { sources: d.sources.map((s) => ({ ...s, revision: 'main' })) },
    { context_length: 0 },
    { context_length: 65536 },
    { minimum_flm_version: 'flm-999999999999999999.1.0-r1' },
  ])
    expect(() => buildFastFlowLmConfig({ ...d, ...change } as typeof d)).toThrow()
})

it('rejects differently cased names for the same parent directory before download', () => {
  const d = parseFastFlowLmDescriptor(candidate.definition)
  const files = [...d.files, ...['kernels/a.bin', 'Kernels/b.bin'].map((path) => ({ ...d.files[0]!, path }))]
  expect(() => parseFastFlowLmDescriptor({ ...d, files })).toThrow(/directory/)
})
