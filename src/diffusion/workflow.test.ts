import { describe, expect, it } from 'vitest'
import {
  defaultStrength,
  IMAGE_WORKFLOWS,
  usesInitImage,
  usesMask,
  usesReferences,
  workflowOf,
  workflowsForFamily,
} from './workflow.js'

describe('workflowsForFamily', () => {
  // Port of `every_image_family_gets_the_img2img_workflows_and_klein_gets_references`
  // (`session.rs`, app commit 767ff6350).
  it('gives every image family the img2img workflows, and references only to Klein', () => {
    for (const family of ['z-image', 'flux.1', 'qwen-image'])
      expect(workflowsForFamily(family), family).toEqual([
        'create',
        'transform',
        'inpaint',
        'extend',
        'upscale',
      ])
    const klein = workflowsForFamily('flux.2-klein')
    expect(klein).toContain('reference')
    expect(klein).toContain('edit')
    expect(klein).toHaveLength(7)
    expect(workflowsForFamily('wan2.2-ti2v-5b')).toEqual(['create'])
    expect(workflowsForFamily('unknown')).toEqual(['create'])
  })
})

describe('what a workflow sends', () => {
  it('splits the seven workflows into create, init-image and reference', () => {
    const table = IMAGE_WORKFLOWS.map((w) => [w, usesInitImage(w), usesMask(w), usesReferences(w)])
    expect(table).toEqual([
      ['create', false, false, false],
      ['transform', true, false, false],
      ['inpaint', true, true, false],
      ['extend', true, true, false],
      ['upscale', true, false, false],
      ['reference', false, false, true],
      ['edit', false, false, true],
    ])
  })

  it('defaults the strength per workflow, as sd.cpp would not', () => {
    expect(defaultStrength('extend')).toBe(1.0)
    expect(defaultStrength('upscale')).toBe(0.35)
    for (const w of ['create', 'transform', 'inpaint', 'reference', 'edit'] as const)
      expect(defaultStrength(w), w).toBe(0.75)
  })

  it('reads an absent workflow as create', () => {
    expect(workflowOf({})).toBe('create')
    expect(workflowOf({ workflow: 'edit' })).toBe('edit')
  })
})
