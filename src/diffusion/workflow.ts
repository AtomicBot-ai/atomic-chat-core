/**
 * What each workflow sends to `img_gen`, and which model family can run which. `ImageWorkflow` in
 * `state.rs` and `workflows_for_family` in `session.rs` (app commit `767ff6350`).
 */

import type { ImageGenerateRequest, ImageWorkflowId } from '../contracts/index.js'

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
 * a mask blends latents), so every image family gets them. Reference-guided generation and
 * instruction edits need a model trained on reference images: of the catalog families only
 * FLUX.2 Klein is. Anything else, video families included, only creates.
 */
export function workflowsForFamily(family: string): ImageWorkflowId[] {
  switch (family) {
    case 'flux.2-klein':
      return ['create', 'transform', 'inpaint', 'extend', 'upscale', 'reference', 'edit']
    case 'z-image':
    case 'flux.1':
    case 'qwen-image':
      return ['create', 'transform', 'inpaint', 'extend', 'upscale']
    default:
      return ['create']
  }
}
