/**
 * Which engine a GGUF file needs: the wire shapes of `POST /atomic/v1/models/compatibility` and of
 * the verdict the load gate applies (PrismML Bonsai, 2026-10-05 ADRs). Browser-safe: types only.
 */

import type { LocalProviderId } from './session.js'

/** What a file needs from an engine. `q1_0` and `q2_0_g64` stock llama.cpp runs too. */
export type EngineCapability = 'q1_0' | 'q2_0_g64' | 'pq2_0' | 'ptq1_0' | 'hadamard' | 'vision'

/**
 * `compatible`: runs on `provider` (or on whatever the caller picked when `provider` is `null`).
 * `engine_required`: needs `atomic-prism`, which is not installed. `engine_update_required`: needs a
 * newer `atomic-prism` build than the installed one. `legacy_artifact`: an old layout no current
 * engine runs (see `replacement`). `inspection_required`: nothing is known yet; read the header.
 * `unsupported`: recognised and refused (an F16 master, an unknown tensor type).
 */
export type CompatibilityOutcome =
  | 'compatible'
  | 'engine_required'
  | 'engine_update_required'
  | 'legacy_artifact'
  | 'inspection_required'
  | 'unsupported'

export interface CompatibilityVerdict {
  outcome: CompatibilityOutcome
  /** The provider the file must run on; `null` = any llama.cpp provider, keep the caller's choice. */
  provider: LocalProviderId | null
  /** Capabilities beyond what stock llama.cpp runs. */
  requires: EngineCapability[]
  /** What decided: a conf rule for this exact file, the GGUF header, or nothing yet. */
  evidence: 'rules' | 'header' | 'none'
  rules_version: number
  /** Oldest PrismML build known to run the file. */
  min_prism_build?: number
  /** The PrismML build installed now, `null` when none is. */
  installed_prism_build?: number | null
  /** `legacy_artifact`: the file to get instead (same repository). */
  replacement?: string
  /** The conf family the file belongs to, when a rule matched. */
  family?: string
  /** One line for logs and error details. */
  reason: string
}

export interface ModelCompatibilityRequest {
  /** A model already on disk (its `model.yml` id under the shared GGUF tree). */
  model_id?: string
  /** A file before download: `owner/repo` + file name (+ revision). */
  repo?: string
  file?: string
  revision?: string
  sha256?: string
  /** Read the remote header over HTTP ranges when no rule matches (≈ 6–12 MB for Bonsai). */
  inspect_remote?: boolean
  /** The provider the caller intends to use; a verdict for another provider is still returned. */
  provider?: LocalProviderId
}

export interface ModelCompatibilityResponse extends CompatibilityVerdict {
  /** Family defaults from conf (sampling, context) when a rule matched. */
  defaults?: {
    sampling?: { temperature?: number; top_p?: number; top_k?: number; min_p?: number }
    ctx_len?: number
  }
}

/** A file of a Bonsai family the Hub may offer: the conf rules neither exclude it nor call it legacy. */
export interface PrismFamilyFile {
  file: string
  size: number
  sha256: string
  packing?: string
  /** `prism_required`: only PrismML runs it; `any`: every llama.cpp engine does. */
  treatment: 'prism_required' | 'any'
  /** The file the family recommends. */
  default?: boolean
  summary?: string
}

export interface PrismFamilyProjector {
  file: string
  size: number
  sha256: string
  default?: boolean
}

/** One Bonsai model as the conf model rules name it, pinned to a revision. */
export interface PrismFamily {
  id: string
  title: string
  repo: string
  revision: string
  featured?: boolean
  files: PrismFamilyFile[]
  projectors: PrismFamilyProjector[]
}

/**
 * `GET /atomic/v1/models/atomic-prism/families`: the Bonsai families of the newest model rules the
 * core has (live, cached or bundled), for the Hub's PrismML list. A family with no file to offer
 * is left out.
 */
export interface PrismFamiliesResponse {
  rules_version: number
  families: PrismFamily[]
}
