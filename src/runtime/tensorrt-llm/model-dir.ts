/**
 * Reading an installed `tensorrt-llm` model's directory under `<data>/tensorrt-llm/models/`: its
 * `model.yml` (`parseTensorrtLlmModelYml`, task 2.16 — the TRT-specific schema documented in
 * `docs/contracts.md`: `repository`, `revision`, `architectures`, `quantization`, `files` with
 * `path`/`size`/`sha256`) and the few derived facts a load needs — the first architecture (for the
 * descriptor's `model_families` entry) and the weight bytes (for the readiness timeout). The app and
 * the CLI write the directory and its `model.yml` last (spec `tensorrt-llm-models`); a directory
 * without one is a download still in progress and is not a model.
 *
 * `readTensorrtLlmModel` is the single-id lookup `TensorrtLlmRuntime.load` uses (task 2.14); the full
 * `ModelRegistry` scan across every installed model (`registry.ts`, task 2.16) shares
 * `parseTensorrtLlmModelYml` with it, so both agree about what `model.yml` means.
 */
import { readFile } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { parse } from 'yaml'
import { AtomicCoreError } from '../../contracts/index.js'
import { MODEL_YML, modelDirFromId } from '../../config/index.js'
import { weightBytes } from './compatibility.js'
import type { CheckpointFile } from './compatibility.js'

/** `model.yml`'s own fields, parsed and typed; nothing here is derived. */
export interface TensorrtLlmModelYmlDocument {
  /** `null` when `model.yml` does not carry one (tolerated: `readTensorrtLlmModel`'s own contract). */
  repository: string | null
  revision: string | null
  architectures: string[]
  quantization: string | null
  files: CheckpointFile[]
}

export interface TensorrtLlmModel {
  id: string
  /** The checkpoint directory as core sees it; mounted read-only into the container. */
  dir: string
  repository: string | null
  revision: string | null
  /** `architectures[0]`: the Hugging Face class name the descriptor's `model_families` is keyed by. */
  architecture: string | null
  quantization: string | null
  /** The revision's file listing exactly as `model.yml` recorded it (the pre-launch check's input). */
  files: CheckpointFile[]
  /** Weight bytes of `files` (`weightBytes`), 0 when `model.yml` lists none. */
  weightBytes: number
}

/** An id is one or more `/`-separated path segments inside the models directory, never out of it. */
function assertModelId(modelsDir: string, modelId: string): string {
  const segments = modelId.split('/')
  if (modelId === '' || segments.some((s) => s === '' || s === '.' || s === '..' || s.includes('\\'))) {
    throw new AtomicCoreError('INVALID_ARGUMENT', 'Not a tensorrt-llm model id.', modelId)
  }
  const dir = modelDirFromId(modelsDir, modelId)
  const inside = relative(modelsDir, dir)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new AtomicCoreError('INVALID_ARGUMENT', 'Not a tensorrt-llm model id.', modelId)
  }
  return dir
}

function fileList(raw: unknown): CheckpointFile[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry: unknown) => {
    const file = entry as { path?: unknown; size?: unknown; sha256?: unknown } | null
    if (file === null || typeof file !== 'object') return []
    if (typeof file.path !== 'string' || typeof file.size !== 'number') return []
    return [
      { path: file.path, size: file.size, sha256: typeof file.sha256 === 'string' ? file.sha256 : null },
    ]
  })
}

/**
 * `model.yml`'s codec (`parse` only — the app and the CLI write it, core never does, spec
 * `tensorrt-llm-models`): `MANAGED_METADATA_INVALID` when `text` is not valid YAML or not a mapping.
 * Every other field tolerates absence or the wrong type by reading as `null`/`[]`/empty, the same way
 * `readTensorrtLlmModel`'s own tests already expect for a bare `model.yml` — a model missing optional
 * metadata is still a model, not a broken one.
 */
export function parseTensorrtLlmModelYml(text: string, path: string): TensorrtLlmModelYmlDocument {
  let yml: unknown
  try {
    yml = parse(text)
  } catch (error) {
    throw new AtomicCoreError('MANAGED_METADATA_INVALID', `${path} is not valid YAML.`, String(error))
  }
  if (yml === null || typeof yml !== 'object' || Array.isArray(yml)) {
    throw new AtomicCoreError('MANAGED_METADATA_INVALID', `${path} does not describe a model.`, path)
  }
  const doc = yml as Record<string, unknown>
  const architectures = Array.isArray(doc['architectures'])
    ? doc['architectures'].filter((entry): entry is string => typeof entry === 'string' && entry !== '')
    : []
  return {
    repository: typeof doc['repository'] === 'string' ? doc['repository'] : null,
    revision: typeof doc['revision'] === 'string' ? doc['revision'] : null,
    architectures,
    quantization: typeof doc['quantization'] === 'string' ? doc['quantization'] : null,
    files: fileList(doc['files']),
  }
}

/** `MODEL_NOT_FOUND` without a readable `model.yml`; `MANAGED_METADATA_INVALID` when it is not a mapping. */
export async function readTensorrtLlmModel(modelsDir: string, modelId: string): Promise<TensorrtLlmModel> {
  const dir = assertModelId(modelsDir, modelId)
  const path = join(dir, MODEL_YML)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    throw new AtomicCoreError(
      'MODEL_NOT_FOUND',
      `The tensorrt-llm model '${modelId}' is not installed.`,
      path
    )
  }
  const yml = parseTensorrtLlmModelYml(text, path)
  return {
    id: modelId,
    dir,
    repository: yml.repository,
    revision: yml.revision,
    architecture: yml.architectures[0] ?? null,
    quantization: yml.quantization,
    files: yml.files,
    weightBytes: weightBytes(yml.files),
  }
}
