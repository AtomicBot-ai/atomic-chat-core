import { expect, it } from 'vitest'
import candidate from '../../test/fixtures/fastflowlm/qwen3-candidate.json' with { type: 'json' }
import { parseFastFlowLmDefinition, projectFastFlowLmCollection } from './fastflowlm-catalog.js'

it('rejects escaped paths, incomplete inventories and unsupported requirements', () => {
  for (const change of [
    (d: typeof candidate.definition) => {
      d.files[0]!.source_path = '../outside'
    },
    (d: typeof candidate.definition) => {
      d.files[0]!.path = 'NUL.txt'
    },
    (d: typeof candidate.definition) => {
      d.files[0]!.sha256 = 'no-hash'
    },
    (d: typeof candidate.definition) => {
      d.components.weights = []
    },
    (d: typeof candidate.definition) => {
      d.components.weights = ['missing.q4nx']
    },
    (d: typeof candidate.definition) => {
      d.npu_generation = 'xdna1'
    },
    (d: typeof candidate.definition) => {
      d.local_only_protocol = 0
    },
  ]) {
    const entry = structuredClone(candidate)
    change(entry.definition)
    expect(() => parseFastFlowLmDefinition(entry, { allowCandidates: true })).toThrow('FastFlowLM')
  }
})
it('rejects repeated references and isolates the installer plan from the catalog', () => {
  const ref = { model: 'qwen', variant: candidate.definition.variant_id }
  const collection = { header: { schema_version: 1 }, entries: [ref] }
  const catalog = {
    schema_version: 1 as const,
    updated_at: 'fixture',
    models: { qwen: candidate },
    collections: { 'fastflowlm-models': collection },
  }
  const projected = projectFastFlowLmCollection(catalog, { allowCandidates: true })
  projected.models[0]!.sources.length = 0
  expect(candidate.definition.sources.length).toBeGreaterThan(0)
  collection.entries.push(ref)
  expect(() => projectFastFlowLmCollection(catalog, { allowCandidates: true })).toThrow('reference')
})

it('rejects variant IDs that cannot name a Windows installation directory', () => {
  for (const variant_id of ['nul', 'aux.model', 'qwen.']) {
    const entry = {
      ...candidate,
      definition: { ...candidate.definition, variant_id },
      variants: { [variant_id]: {} },
    }
    expect(() => parseFastFlowLmDefinition(entry, { allowCandidates: true })).toThrow('model identity')
  }
})

it('accepts upstream catalog provenance without claiming hardware qualification', () => {
  const entry = {
    ...structuredClone(candidate),
    definition: {
      ...structuredClone(candidate.definition),
      qualification: { status: 'upstream', evidence: [] as string[] },
    },
  }
  entry.definition.qualification = {
    status: 'upstream',
    evidence: ['https://github.com/ROCm/FastFlowLM/blob/pinned/src/model_list.json'],
  }
  expect(parseFastFlowLmDefinition(entry).qualification.status).toBe('upstream')
  entry.definition.qualification.evidence = []
  expect(() => parseFastFlowLmDefinition(entry)).toThrow('qualification')
  entry.definition.qualification = { status: 'candidate', evidence: [] }
  expect(() => parseFastFlowLmDefinition(entry)).toThrow('unqualified candidate')
})
