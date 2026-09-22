import { describe, expect, it } from 'vitest'
import {
  defaultStrength,
  IMAGE_WORKFLOWS,
  usesInitImage,
  usesMask,
  usesReferences,
  workflowOf,
  workflowsForFamily,
  workflowsForSpec,
} from './workflow.js'

describe('workflowsForFamily', () => {
  // Port of `families_expose_only_the_workflows_their_architecture_supports`
  // (`session.rs`, app commit ec1fd3ea7).
  it('gives each family only the workflows its architecture supports', () => {
    const img2img = ['create', 'transform', 'inpaint', 'extend', 'upscale']
    for (const family of ['z-image', 'flux.1', 'qwen-image'])
      expect(workflowsForFamily(family), family).toEqual(img2img)
    const klein = workflowsForFamily('flux.2-klein')
    expect(klein).toContain('reference')
    expect(klein).toContain('edit')
    expect(klein).toHaveLength(7)
    expect(workflowsForFamily('qwen-image-2.1')).toEqual(['create', 'reference', 'edit'])
    expect(workflowsForFamily('krea-2-turbo')).toEqual(['create'])
    expect(workflowsForFamily('wan2.2-ti2v-5b')).toEqual(['create'])
    expect(workflowsForFamily('unknown')).toEqual(['create'])
  })

  it('treats every flux.1 variant as flux.1', () => {
    for (const family of ['flux.1-uncensored', 'flux.1-abliterated', 'flux.1-nsfw-realism', 'flux.1-krea'])
      expect(workflowsForFamily(family), family).toEqual(workflowsForFamily('flux.1'))
  })
})

describe('workflowsForSpec', () => {
  // Port of `qwen_image_2_1_reference_workflows_require_the_vision_projector` (`session.rs`).
  it('drops the reference workflows of Qwen Image 2.1 loaded without its vision projector', () => {
    const files = { diffusionModel: '/models/qwen-image-2.1.gguf', llm: '/models/qwen3-vl-8b.gguf' }
    expect(workflowsForSpec({ family: 'qwen-image-2.1', files })).toEqual(['create'])
    expect(
      workflowsForSpec({ family: 'qwen-image-2.1', files: { ...files, llmVision: '/models/mmproj.gguf' } })
    ).toEqual(['create', 'reference', 'edit'])
  })

  it('leaves every other family to workflowsForFamily', () => {
    const files = { diffusionModel: '/m.gguf' }
    expect(workflowsForSpec({ family: 'flux.2-klein', files })).toEqual(workflowsForFamily('flux.2-klein'))
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
