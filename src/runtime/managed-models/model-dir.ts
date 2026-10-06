/**
 * Reading an installed `tensorrt-llm` model's directory under `<data>/tensorrt-llm/models/`: its
 * `model.yml` (`parseManagedModelYml`, task 2.16 — the TRT-specific schema documented in
 * `docs/contracts.md`: `repository`, `revision`, `architectures`, `quantization`, `files` with
 * `path`/`size`/`sha256`) and the few derived facts a load needs — the first architecture (for the
 * descriptor's `model_families` entry) and the weight bytes (for the readiness timeout). The app and
 * the CLI write the directory and its `model.yml` last (spec `tensorrt-llm-models`); a directory
 * without one is a download still in progress and is not a model.
 *
 * `readManagedModel` is the single-id lookup `TensorrtLlmRuntime.load` uses (task 2.14); the full
 * `ModelRegistry` scan across every installed model (`registry.ts`, task 2.16) shares
 * `parseManagedModelYml` with it, so both agree about what `model.yml` means.
 */
import { readFile } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { parse } from 'yaml'
import { AtomicCoreError } from '../../contracts/index.js'
import { MODEL_YML, modelDirFromId } from '../../config/index.js'
import { weightBytes } from './compatibility.js'
import type { CheckpointFile } from './compatibility.js'

/** `model.yml`'s own fields, parsed and typed; nothing here is derived. */
export interface ManagedModelYmlDocument {
  /** `null` when `model.yml` does not carry one (tolerated: `readManagedModel`'s own contract). */
  repository: string | null
  revision: string | null
  architectures: string[]
  quantization: string | null
  files: CheckpointFile[]
}

export interface ManagedModel {
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

/**
 * A relative file path safe to join onto the model directory and mount read-only into a container:
 * forward-slash separated, never absolute, no empty/`.`/`..` segment and no backslash (which some
 * shells would treat as an escape on the file's own leaf name).
 */
function isSafeRelativePath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\')) return false
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/**
 * One `model.yml` `files[]` entry, strictly: `MANAGED_METADATA_INVALID` for anything malformed
 * (task 2.16w round 1, finding 4) — a non-string or unsafe `path`, a `size` that is not a finite
 * non-negative integer, a `sha256` that is neither a string nor `null`. The previous, lenient
 * parsing silently dropped a malformed entry instead: an unverified shard the pre-launch check would
 * never even look for, a checkpoint's weight bytes under-counted, or an `hf_quant_config.json` entry
 * quietly lost — every one of those is worse than refusing the model outright and naming why.
 */
function parseFileEntry(raw: unknown, index: number, path: string): CheckpointFile {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AtomicCoreError(
      'MANAGED_METADATA_INVALID',
      `${path}: files[${index}] is not a mapping.`,
      JSON.stringify(raw)
    )
  }
  const entry = raw as { path?: unknown; size?: unknown; sha256?: unknown }
  if (typeof entry.path !== 'string' || !isSafeRelativePath(entry.path)) {
    throw new AtomicCoreError(
      'MANAGED_METADATA_INVALID',
      `${path}: files[${index}].path is not a safe relative path.`,
      String(entry.path)
    )
  }
  if (typeof entry.size !== 'number' || !Number.isInteger(entry.size) || entry.size < 0) {
    throw new AtomicCoreError(
      'MANAGED_METADATA_INVALID',
      `${path}: files[${index}].size must be a non-negative integer.`,
      String(entry.size)
    )
  }
  if (entry.sha256 !== undefined && entry.sha256 !== null && typeof entry.sha256 !== 'string') {
    throw new AtomicCoreError(
      'MANAGED_METADATA_INVALID',
      `${path}: files[${index}].sha256 must be a string or null.`,
      String(entry.sha256)
    )
  }
  return {
    path: entry.path,
    size: entry.size,
    sha256: typeof entry.sha256 === 'string' ? entry.sha256 : null,
  }
}

/** `files` absent entirely is tolerated as `[]` (a bare `model.yml` is still a model); once present, every entry must be well-formed. */
function fileList(raw: unknown, path: string): CheckpointFile[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    throw new AtomicCoreError(
      'MANAGED_METADATA_INVALID',
      `${path}: files must be an array.`,
      JSON.stringify(raw)
    )
  }
  return raw.map((entry, index) => parseFileEntry(entry, index, path))
}

/**
 * `model.yml`'s codec (`parse` only — the app and the CLI write it, core never does, spec
 * `tensorrt-llm-models`): `MANAGED_METADATA_INVALID` when `text` is not valid YAML or not a mapping.
 * `repository`/`revision`/`architectures`/`quantization` tolerate absence or the wrong type by
 * reading as `null`/`[]`, the same way `readManagedModel`'s own tests already expect for a bare
 * `model.yml` — a model missing optional metadata is still a model, not a broken one. `files` is the
 * one field held to a stricter rule (task 2.16w round 1, finding 4): the array itself may be absent
 * (`[]`), but once present every entry must be well-formed (`fileList`/`parseFileEntry`) —
 * silently dropping a malformed entry would leave a shard unverified, a checkpoint's weight bytes
 * under-counted, or an `hf_quant_config.json` entry quietly lost.
 */
export function parseManagedModelYml(text: string, path: string): ManagedModelYmlDocument {
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
    files: fileList(doc['files'], path),
  }
}

/** `MODEL_NOT_FOUND` without a readable `model.yml`; `MANAGED_METADATA_INVALID` when it is not a mapping. */
export async function readManagedModel(modelsDir: string, modelId: string): Promise<ManagedModel> {
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
  const yml = parseManagedModelYml(text, path)
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
