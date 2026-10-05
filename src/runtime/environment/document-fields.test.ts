import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import { documentFields, installRecipe } from './document-fields.js'

const fields = documentFields('toy document')

const thrown = (run: () => unknown): AtomicCoreError => {
  try {
    run()
  } catch (error) {
    return error as AtomicCoreError
  }
  throw new Error('expected a refusal')
}

describe('documentFields', () => {
  it('names the document and the field, as MANAGED_METADATA_INVALID', () => {
    const error = thrown(() => fields.text('', 'notes[0]'))
    expect(error).toBeInstanceOf(AtomicCoreError)
    expect(error.code).toBe('MANAGED_METADATA_INVALID')
    expect(error.message).toBe('Invalid toy document: notes[0] is not a non-empty string')
  })

  it('refuses unknown keys, listing every one, sorted', () => {
    const error = thrown(() => fields.known({ a: 1, z: 2, b: 3 }, 'the toy', ['a']))
    expect(error.message).toBe('Invalid toy document: the toy has unknown fields')
    expect(error.details).toBe('b, z')
  })

  it('accepts what fits and refuses what does not', () => {
    expect(fields.object({ a: 1 }, 'x')).toEqual({ a: 1 })
    expect(() => fields.object([], 'x')).toThrow(AtomicCoreError)
    expect(fields.boolean(false, 'x')).toBe(false)
    expect(() => fields.boolean('false', 'x')).toThrow(AtomicCoreError)
    expect(fields.strings(['a', 'b'], 'x')).toEqual(['a', 'b'])
    expect(() => fields.list({}, 'x')).toThrow(AtomicCoreError)
    expect(fields.pattern(/^a+$/, 'a run of a')('aaa', 'x')).toBe('aaa')
    expect(thrown(() => fields.pattern(/^a+$/, 'a run of a')('ab', 'x')).details).toBe('ab')
    expect(fields.bytes(1, 'x', 1)).toBe(1)
    expect(() => fields.bytes(0, 'x', 1)).toThrow(AtomicCoreError)
    expect(() => fields.bytes(1.5, 'x')).toThrow(AtomicCoreError)
    expect(() => fields.unique(['a', 'a'], 'x', 'a letter')).toThrow(/lists a letter twice/)
  })
})

describe('installRecipe', () => {
  const ubuntu = { id: 'ubuntu', version_id: '24.04', arch: 'x86_64' }

  it('reads an id and its distributions, nothing else', () => {
    expect(installRecipe(fields, { recipe_id: 'linux.x', distributions: [ubuntu] }, 'r')).toEqual({
      recipe_id: 'linux.x',
      distributions: [ubuntu],
    })
  })

  it.each([
    ['a command', { recipe_id: 'linux.x', distributions: [ubuntu], command: 'sh -c' }],
    ['no distributions', { recipe_id: 'linux.x', distributions: [] }],
    ['a distribution twice', { recipe_id: 'linux.x', distributions: [ubuntu, { ...ubuntu }] }],
    ['an unknown architecture', { recipe_id: 'linux.x', distributions: [{ ...ubuntu, arch: 'i686' }] }],
    ['a field on a distribution', { recipe_id: 'linux.x', distributions: [{ ...ubuntu, url: 'x' }] }],
  ])('refuses a recipe with %s', (_label, value) => {
    expect(() => installRecipe(fields, value, 'r')).toThrow(AtomicCoreError)
  })

  it('keeps the same distribution on another architecture', () => {
    const both = [ubuntu, { ...ubuntu, arch: 'aarch64' }]
    expect(
      installRecipe(fields, { recipe_id: 'linux.x', distributions: both }, 'r').distributions
    ).toHaveLength(2)
  })
})
