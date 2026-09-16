import { describe, expect, it } from 'vitest'
import { classifyImport, jsonEqual, legacyHash, planImport, stableStringify } from './import.js'

describe('legacyHash', () => {
  it('is the same for the same values however they were serialised', () => {
    expect(legacyHash({ a: 1, b: { c: 2, d: 3 } })).toBe(legacyHash({ b: { d: 3, c: 2 }, a: 1 }))
  })

  it('changes when any value changes', () => {
    expect(legacyHash({ a: 1 })).not.toBe(legacyHash({ a: 2 }))
    expect(legacyHash({ a: 1 })).not.toBe(legacyHash({ a: '1' }))
  })

  it('treats an absent key and an undefined one as the same, as JSON does', () => {
    expect(legacyHash({ a: 1, b: undefined })).toBe(legacyHash({ a: 1 }))
  })

  it('keeps array order, which is part of the value', () => {
    expect(stableStringify(['b', 'a'])).toBe('["b","a"]')
    expect(jsonEqual(['a', 'b'], ['b', 'a'])).toBe(false)
  })
})

describe('planImport', () => {
  const base = { ctx_size: 4096, n_gpu_layers: 100, flash_attn: true }

  it('takes a value only the app changed', () => {
    const plan = planImport(base, { ...base }, { ...base, ctx_size: 8192 })

    expect(plan.apply).toEqual({ ctx_size: 8192 })
    expect(plan.conflicts).toEqual([])
  })

  it('keeps a value only the core changed, and does not report it', () => {
    // Someone set this through the CLI while the app was closed; re-importing the app's unchanged
    // settings must not undo it.
    const plan = planImport(base, { ...base, n_gpu_layers: 50 }, { ...base })

    expect(plan.apply).toEqual({})
    expect(plan.conflicts).toEqual([])
  })

  it('writes nothing when both sides already agree', () => {
    const plan = planImport(base, { ...base, ctx_size: 8192 }, { ...base, ctx_size: 8192 })

    expect(plan.apply).toEqual({})
    expect(plan.conflicts).toEqual([])
  })

  it('reports a key both sides moved in different directions', () => {
    const plan = planImport(base, { ...base, ctx_size: 2048 }, { ...base, ctx_size: 8192 })

    expect(plan.conflicts).toEqual([{ key: 'ctx_size', base: 4096, core: 2048, legacy: 8192 }])
  })

  it('writes nothing at all when any key conflicts', () => {
    // A partial write would leave a scope half-migrated, which neither side has accepted.
    const plan = planImport(base, { ...base, ctx_size: 2048 }, { ...base, ctx_size: 8192, n_gpu_layers: 80 })

    expect(plan.apply).toEqual({})
    expect(plan.conflicts).toHaveLength(1)
  })

  it('applies the resolution the caller chose', () => {
    const conflicting = { ...base, ctx_size: 8192 }
    const core = { ...base, ctx_size: 2048 }

    expect(planImport(base, core, conflicting, { ctx_size: 'legacy' }).apply).toEqual({
      ctx_size: 8192,
    })
    expect(planImport(base, core, conflicting, { ctx_size: 'core' }).apply).toEqual({})
    expect(planImport(base, core, conflicting, { ctx_size: { value: 6144 } }).apply).toEqual({
      ctx_size: 6144,
    })
  })

  it('takes a key the app added', () => {
    expect(planImport(base, { ...base }, { ...base, new_key: 'x' }).apply).toEqual({ new_key: 'x' })
  })

  it('leaves alone a key the app does not carry, rather than unsetting it', () => {
    // An older app version that never had the setting, or one that dropped it. Writing `undefined`
    // here would replace a value the core legitimately holds with nothing.
    const dropped = { ctx_size: 4096, n_gpu_layers: 100 }

    const plan = planImport(base, { ...base, flash_attn: false }, dropped)

    expect(plan.apply).toEqual({})
    expect(plan.conflicts).toEqual([])
  })

  it('compares structurally, so a reordered object is not a change', () => {
    const withObject = { opts: { a: 1, b: 2 } }
    const plan = planImport(withObject, { opts: { a: 1, b: 2 } }, { opts: { b: 2, a: 1 } })

    expect(plan.apply).toEqual({})
    expect(plan.conflicts).toEqual([])
  })
})

describe('classifyImport', () => {
  const clean = { apply: { a: 1 }, conflicts: [] }
  const clashing = {
    apply: {},
    conflicts: [{ key: 'a', base: 1, core: 2, legacy: 3 }],
  }

  it('calls the first import an import and a later clean merge a merge', () => {
    expect(classifyImport(null, false, 'h1', clean)).toBe('imported')
    expect(classifyImport('h1', true, 'h2', clean)).toBe('merged')
  })

  it('reports the same legacy state as unchanged rather than as an error', () => {
    // The app imports on every start; the second start must not look like a failure.
    expect(classifyImport('h1', true, 'h1', { apply: {}, conflicts: [] })).toBe('unchanged')
  })

  it('reports a conflict whatever the history is', () => {
    expect(classifyImport(null, false, 'h1', clashing)).toBe('conflict')
    expect(classifyImport('h1', true, 'h1', clashing)).toBe('conflict')
  })
})
