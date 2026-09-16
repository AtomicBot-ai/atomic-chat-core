/**
 * What the app asks about a model without loading it (PLAN.md §4, stage 3d).
 *
 * These are the extension's remaining "off-contract" methods — the ones that are not part of the
 * provider interface but that the app calls anyway: is this file a usable GGUF, does this model
 * have a projector, how large a context was it trained for, can it use speculative decoding. Every
 * one of them is a question about files inside the data folder, which is why they move with the
 * folder's owner rather than staying in a process that may no longer own it.
 *
 * All of them answer rather than throw. "This file is not a model" is the answer to a question the
 * user asked by pointing at a file, not a failure of the core; the caller renders it.
 */

import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DataLayout } from '../config/index.js'
import type { LocalProviderId } from '../contracts/index.js'
import { checkDflashSupport, checkGemmaMtpSupport, listDflashDrafts } from '../speculative/index.js'
import { classifyProjector, ggufContextLength, isEmbeddingGguf } from './gguf/index.js'
import { readGgufMetadataFromFile } from './gguf/read-file.js'
import type { ModelRegistry } from './registry.js'

export interface GgufValidation {
  isValid: boolean
  error?: string
  metadata?: Record<string, string>
}

export interface ModelCapabilities {
  modelId: string
  /** `{general.architecture}.context_length` — the ceiling for the context ladder. */
  maxCtxTrain?: number
  /** A projector file exists, so this model can be given images. */
  mmprojExists: boolean
  isEmbedding: boolean
  vision: boolean
  audio: boolean
  /** Speculative decoding this model id is known to support. */
  gemmaMtp: boolean
  dflash: boolean
  dflashDrafts: string[]
}

export interface CapabilitiesDeps {
  layout: DataLayout
  registry: (provider: LocalProviderId) => ModelRegistry
  /** Test seam; production reads the file. */
  readMetadata?: (path: string) => Promise<Record<string, string>>
  exists?: (path: string) => Promise<boolean>
}

const defaultExists = (path: string) =>
  stat(path).then(
    () => true,
    () => false
  )

export class ModelCapabilityService {
  constructor(private readonly deps: CapabilitiesDeps) {}

  /**
   * Whether a file can be imported as a text-generation model.
   *
   * The one rejection that matters is a CLIP architecture: those files are projectors, they parse
   * as perfectly good GGUF, and importing one as a model produces a session that answers every
   * prompt with nothing. The app has always named this case specifically, so the core does too.
   */
  async validateGguf(filePath: string): Promise<GgufValidation> {
    let metadata: Record<string, string>
    try {
      metadata = await this.readMetadata(filePath)
    } catch (e) {
      return { isValid: false, error: (e as Error).message }
    }
    const architecture = metadata['general.architecture']
    if (architecture === 'clip') {
      return {
        isValid: false,
        error:
          'This model has CLIP architecture and cannot be imported as a text generation model. ' +
          'CLIP models are designed for vision tasks and require different handling.',
        metadata,
      }
    }
    return { isValid: true, metadata }
  }

  /**
   * Everything the app wants to know about an installed model.
   *
   * Answered from `model.yml` and the GGUF header together: the yml says where the files are and
   * may name a projector explicitly, and the header says what the model is. A model whose files
   * cannot be read still gets an answer — every capability false — because the caller is deciding
   * what to show in a list, not whether to load it.
   */
  async capabilities(provider: LocalProviderId, modelId: string): Promise<ModelCapabilities> {
    const base: ModelCapabilities = {
      modelId,
      mmprojExists: false,
      isEmbedding: false,
      vision: false,
      audio: false,
      gemmaMtp: checkGemmaMtpSupport(modelId),
      dflash: checkDflashSupport(modelId),
      dflashDrafts: listDflashDrafts(modelId).map((draft) => draft.quant),
    }

    const registry = this.deps.registry(provider)
    const yml = await registry.read(modelId).catch(() => undefined)
    if (!yml) return base

    const paths = registry.resolvePaths(yml)
    const projectorPath = await this.projectorPath(provider, modelId, paths.mmprojPath)
    base.mmprojExists = projectorPath !== undefined

    // What a model can be given comes from the *projector's* header, not the model's:
    // `classifyProjector` answers "vision" for metadata with no clip keys at all, because a file
    // that is a projector and says nothing else is a vision projector. Asked about a text model it
    // would therefore claim every one of them takes images.
    if (projectorPath) {
      const projectorMeta = await this.readMetadata(projectorPath).catch(() => undefined)
      if (projectorMeta) {
        const projector = classifyProjector(projectorMeta)
        base.vision = projector.vision
        base.audio = projector.audio
      }
    }

    const metadata = await this.readMetadata(paths.modelPath).catch(() => undefined)
    if (!metadata) return base

    const maxCtxTrain = ggufContextLength(metadata)
    return {
      ...base,
      ...(maxCtxTrain !== undefined ? { maxCtxTrain } : {}),
      isEmbedding: isEmbeddingGguf(metadata),
    }
  }

  /**
   * A projector for this model.
   *
   * `model.yml` may name one; when it does not, the conventional `mmproj.gguf` beside the model is
   * still a projector — the app has always looked for both, and a model imported before the yml
   * carried the field would otherwise lose its vision.
   */
  async mmprojExists(provider: LocalProviderId, modelId: string, declared?: string): Promise<boolean> {
    return (await this.projectorPath(provider, modelId, declared)) !== undefined
  }

  /** Where this model's projector is, if it has one. */
  private async projectorPath(
    provider: LocalProviderId,
    modelId: string,
    declared?: string
  ): Promise<string | undefined> {
    const exists = this.deps.exists ?? defaultExists
    // An absolute path already: `resolvePaths` resolved it against the data folder.
    if (declared && (await exists(declared))) return declared
    const conventional = join(this.deps.layout.provider(provider).modelsDir, modelId, 'mmproj.gguf')
    return (await exists(conventional)) ? conventional : undefined
  }

  private async readMetadata(path: string): Promise<Record<string, string>> {
    if (this.deps.readMetadata) return this.deps.readMetadata(path)
    return (await readGgufMetadataFromFile(path)).metadata
  }
}
