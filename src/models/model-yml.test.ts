import { describe, expect, it } from 'vitest'
import { ModelYmlError, parseModelYml, renameModelPaths, serializeModelYml } from './model-yml.js'

const sample = `model_path: llamacpp/models/org/model/q4/model.gguf
mmproj_path: llamacpp/models/org/model/q4/mmproj.gguf
name: org/model/q4
size_bytes: 123456
model_sha256: abc
model_size_bytes: 123000
embedding: false
projector_vision: true
source: huggingface-cache
custom_key: keep-me
`

describe('parseModelYml', () => {
  it('parses known fields and keeps unknown ones', () => {
    const doc = parseModelYml(sample)
    expect(doc.model_path).toBe('llamacpp/models/org/model/q4/model.gguf')
    expect(doc.size_bytes).toBe(123456)
    expect(doc.embedding).toBe(false)
    expect(doc.projector_vision).toBe(true)
    expect(doc['custom_key']).toBe('keep-me')
  })
  it('defaults name to empty and size_bytes to 0, rejects non-mappings and a missing model_path', () => {
    expect(parseModelYml('model_path: x\n')).toMatchObject({ model_path: 'x', name: '', size_bytes: 0 })
    expect(() => parseModelYml('- a\n')).toThrow(ModelYmlError)
    expect(() => parseModelYml('name: only\n')).toThrow(/missing model_path/)
    expect(() => parseModelYml('a: [\n')).toThrow(/invalid YAML/)
  })
})

describe('serializeModelYml', () => {
  it('writes known keys in the app order, omits undefined, appends unknown keys, and round-trips', () => {
    const doc = parseModelYml(sample)
    const text = serializeModelYml({
      ...doc,
      mtp_draft_path: 'llamacpp/models/drafts/mtp.gguf',
      embedding: undefined,
    })
    const lines = text.trim().split('\n')
    expect(lines[0]).toBe('model_path: llamacpp/models/org/model/q4/model.gguf')
    expect(lines.indexOf('mtp_draft_path: llamacpp/models/drafts/mtp.gguf')).toBeGreaterThan(
      lines.indexOf('projector_vision: true')
    )
    expect(lines.at(-1)).toBe('custom_key: keep-me')
    expect(text).not.toContain('embedding:')
    const { embedding: _dropped, ...rest } = doc
    expect(parseModelYml(text)).toMatchObject({ ...rest, mtp_draft_path: 'llamacpp/models/drafts/mtp.gguf' })
    expect(parseModelYml(text)).not.toHaveProperty('embedding')
  })
  it('quotes values YAML would otherwise misread', () => {
    const text = serializeModelYml({ model_path: 'a: b', name: 'yes', size_bytes: 1 })
    expect(parseModelYml(text)).toMatchObject({ model_path: 'a: b', name: 'yes' })
  })
})

describe('renameModelPaths', () => {
  it('rewrites only the id segment inside both path fields', () => {
    const doc = parseModelYml(sample)
    const renamed = renameModelPaths(doc, 'llamacpp/models', 'org/model/q4', 'org/renamed')
    expect(renamed.model_path).toBe('llamacpp/models/org/renamed/model.gguf')
    expect(renamed.mmproj_path).toBe('llamacpp/models/org/renamed/mmproj.gguf')
    expect(renamed['custom_key']).toBe('keep-me')
  })
})
