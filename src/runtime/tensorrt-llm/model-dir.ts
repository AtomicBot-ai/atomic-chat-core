/**
 * The smallest lookup a `tensorrt-llm` load needs (task 2.14): a model id to its directory under
 * `<data>/tensorrt-llm/models/`, and the few facts its `model.yml` gives — the architecture (for the
 * descriptor's `model_families` entry), the quantization and the weight bytes (for the readiness
 * timeout). The app and the CLI write that directory and its `model.yml` last (spec
 * `tensorrt-llm-models`); a directory without one is a download still in progress and is not a model.
 *
 * Task 2.16 builds the full `ModelRegistry` for this provider and the pre-launch check (every file
 * present at its size, compatibility re-checked against `config.json` on disk) on top of this; the
 * `model.yml` keys read here are the ones that spec names: `architectures`, `quantization`, `files`
 * (`path`, `size`, `sha256`), plus `repository`/`revision` which this lookup does not need.
 */
import { readFile } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { parse } from 'yaml'
import { AtomicCoreError } from '../../contracts/index.js'
import { MODEL_YML, modelDirFromId } from '../../config/index.js'
import { weightBytes } from './compatibility.js'
import type { CheckpointFile } from './compatibility.js'

export interface TensorrtLlmModel {
  id: string
  /** The checkpoint directory as core sees it; mounted read-only into the container. */
  dir: string
  /** `architectures[0]`: the Hugging Face class name the descriptor's `model_families` is keyed by. */
  architecture: string | null
  quantization: string | null
  /** Weight bytes of the listed checkpoint files (`weightBytes`), 0 when `model.yml` lists none. */
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
  const architectures = Array.isArray(doc['architectures']) ? doc['architectures'] : []
  const first = architectures[0]
  return {
    id: modelId,
    dir,
    architecture: typeof first === 'string' && first !== '' ? first : null,
    quantization: typeof doc['quantization'] === 'string' ? doc['quantization'] : null,
    weightBytes: weightBytes(fileList(doc['files'])),
  }
}
