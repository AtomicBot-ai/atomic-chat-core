/**
 * What each workflow sends to `img_gen`, and which model family can run which. `ImageWorkflow` in
 * `state.rs` and `workflows_for_family` / `workflows_for_spec` in `session.rs` (app commit
 * `ec1fd3ea7`).
 */

import type { ImageGenerateRequest, ImageWorkflowId } from '../contracts/index.js'
import type { ServerSpec } from './types.js'

export const IMAGE_WORKFLOWS: readonly ImageWorkflowId[] = [
  'create',
  'transform',
  'inpaint',
  'extend',
  'upscale',
  'reference',
  'edit',
]

export function workflowOf(request: Pick<ImageGenerateRequest, 'workflow'>): ImageWorkflowId {
  return request.workflow ?? 'create'
}

/** Workflows that send an `init_image`, and therefore a `strength`. */
export function usesInitImage(workflow: ImageWorkflowId): boolean {
  return workflow === 'transform' || workflow === 'inpaint' || workflow === 'extend' || workflow === 'upscale'
}

export function usesMask(workflow: ImageWorkflowId): boolean {
  return workflow === 'inpaint' || workflow === 'extend'
}

/** Workflows that send `ref_images` instead of an init image. */
export function usesReferences(workflow: ImageWorkflowId): boolean {
  return workflow === 'reference' || workflow === 'edit'
}

/**
 * The denoise strength when the request leaves it unset. `extend` repaints its blank border fully;
 * `upscale` is a re-detail pass that keeps most of the enlarged source.
 */
export function defaultStrength(workflow: ImageWorkflowId): number {
  if (workflow === 'extend') return 1.0
  if (workflow === 'upscale') return 0.35
  return 0.75
}

/**
 * img2img and masking are generic in sd.cpp (the init image is VAE-encoded and noised to `strength`,
 * a mask blends latents), so the established base families get them; a distilled model such as
 * Krea 2 Turbo keeps to its verified Create. Reference-guided generation and instruction edits need
 * a model trained on reference images: FLUX.2 Klein and Qwen Image 2.1, which also needs its vision
 * projector loaded (`workflowsForSpec`). Anything else, video families included, only creates.
 */
export function workflowsForFamily(family: string): ImageWorkflowId[] {
  switch (family) {
    case 'flux.2-klein':
      return ['create', 'transform', 'inpaint', 'extend', 'upscale', 'reference', 'edit']
    case 'qwen-image-2.1':
      return ['create', 'reference', 'edit']
    case 'krea-2-turbo':
      return ['create']
    case 'z-image':
    case 'qwen-image':
      return ['create', 'transform', 'inpaint', 'extend', 'upscale']
    default:
      // flux.1 and its variants: flux.1-uncensored, -abliterated, -nsfw-realism, -krea.
      if (family.startsWith('flux.1')) return ['create', 'transform', 'inpaint', 'extend', 'upscale']
      return ['create']
  }
}

/** The workflows the loaded server can actually run: Qwen Image 2.1 without `llmVision` only creates. */
export function workflowsForSpec(spec: Pick<ServerSpec, 'family' | 'files'>): ImageWorkflowId[] {
  const workflows = workflowsForFamily(spec.family)
  if (spec.family === 'qwen-image-2.1' && spec.files.llmVision === undefined)
    return workflows.filter((workflow) => !usesReferences(workflow))
  return workflows
}
