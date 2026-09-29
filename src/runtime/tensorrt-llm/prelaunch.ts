/**
 * The pre-launch check `TensorrtLlmRuntime.load` runs once `deps.model` has resolved an installed
 * model and before `lifecycle.load` ever creates a container (task 2.16, spec `tensorrt-llm-models`,
 * "Проверка файлов при загрузке"): every file `model.yml` recorded is still on disk at its declared
 * size — a shard deleted after download is refused by name, the way a corrupt GGUF already is for
 * llama.cpp (`MODEL_FILE_NOT_FOUND`/`MODEL_FILE_CORRUPT`, `../llamacpp/load-plan.ts`'s own
 * convention, reused here) — and the compatibility verdict (`compatibility.ts`'s pure
 * `checkModelCompatibility`) is recomputed against `config.json` and `hf_quant_config.json` exactly
 * as they sit in the model's directory right now, not as `model.yml` last recorded them, and against
 * the card this load is about to use (its `gpu_id` is passed in, already resolved and possibly
 * substituted by the caller — this never re-picks a card). No container exists yet; a failure here
 * never creates one.
 *
 * Direct `node:fs/promises`, no injected `exec`/`readFile`: reading the model's own checkpoint
 * directory is local disk I/O, the same convention `model-dir.ts` already uses for `model.yml`
 * itself — nothing here is a shell command or a network call that would need faking on a non-Linux
 * test host.
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import type { GpuFacts, ModelCompatibility, RuntimeDescriptor } from '../../contracts/index.js'
import { checkModelCompatibility } from './compatibility.js'
import type { CheckpointFile, ModelCheckInput } from './compatibility.js'
import type { TensorrtLlmModel } from './model-dir.js'
import type { JsonObject } from './quant-format.js'

const CONFIG_FILE = 'config.json'
const HF_QUANT_CONFIG_FILE = 'hf_quant_config.json'

/** A `model.yml` file path, joined onto the model directory; refuses one that would climb out of it. */
function safeJoin(dir: string, relativePath: string): string {
  const segments = relativePath.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new AtomicCoreError(
      'MANAGED_METADATA_INVALID',
      `model.yml names an unsafe file path: ${relativePath}`,
      relativePath
    )
  }
  return join(dir, ...segments)
}

async function fileSizeOnDisk(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size
  } catch {
    return undefined
  }
}

/** Every file `model.yml` lists, present at its recorded size; a violation refuses by name. */
async function assertFilesOnDisk(dir: string, files: readonly CheckpointFile[]): Promise<void> {
  for (const file of files) {
    const path = safeJoin(dir, file.path)
    const size = await fileSizeOnDisk(path)
    if (size === undefined) {
      throw new AtomicCoreError(
        'MODEL_FILE_NOT_FOUND',
        `The tensorrt-llm model is missing a file recorded in model.yml: ${file.path}`,
        path
      )
    }
    if (size !== file.size) {
      throw new AtomicCoreError(
        'MODEL_FILE_CORRUPT',
        `${file.path} is ${size} bytes on disk, but model.yml recorded ${file.size}.`,
        path
      )
    }
  }
}

/** `null` when the file does not exist; throws `MANAGED_METADATA_INVALID` for one that exists but is not a JSON object. */
async function readJsonObjectFile(path: string): Promise<JsonObject | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new AtomicCoreError('MANAGED_METADATA_INVALID', `${path} is not valid JSON.`, String(error))
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AtomicCoreError('MANAGED_METADATA_INVALID', `${path} is not a JSON object.`, path)
  }
  return parsed as JsonObject
}

export interface VerifyModelBeforeLaunchOptions {
  /** The card this load is about to use; already resolved (and possibly substituted) by the caller. */
  gpuId: string
  kvCacheFreeGpuMemoryFraction: number
}

/**
 * Throws `MODEL_FILE_NOT_FOUND`/`MODEL_FILE_CORRUPT` for a missing or resized checkpoint file, or the
 * pure check's own error (`MODEL_INCOMPATIBLE`/`MANAGED_METADATA_INVALID`/`INVALID_ARGUMENT`) for a
 * checkpoint that no longer checks out — every case before `lifecycle.load` is ever called. Answers
 * the passing verdict on success, mirroring `checkModelCompatibility`'s own shape.
 */
export async function verifyModelBeforeLaunch(
  model: Pick<TensorrtLlmModel, 'dir' | 'repository' | 'revision' | 'files'>,
  descriptor: RuntimeDescriptor,
  gpus: readonly GpuFacts[],
  hostMemAvailableBytes: number,
  options: VerifyModelBeforeLaunchOptions
): Promise<ModelCompatibility> {
  await assertFilesOnDisk(model.dir, model.files)

  const configJson = await readJsonObjectFile(join(model.dir, CONFIG_FILE))
  if (configJson === null) {
    throw new AtomicCoreError(
      'MODEL_FILE_NOT_FOUND',
      'The tensorrt-llm model has no config.json in its directory.',
      join(model.dir, CONFIG_FILE)
    )
  }
  // `assertFilesOnDisk` above already walked `model.files` and would have thrown
  // `MODEL_FILE_NOT_FOUND` had this entry been missing, so a `carriesHfQuantConfig` repository's
  // file is guaranteed present here: `readJsonObjectFile` reads it for real content or throws for
  // malformed JSON, never a silent `null`.
  const carriesHfQuantConfig = model.files.some((file) => file.path === HF_QUANT_CONFIG_FILE)
  const hfQuantConfigJson = carriesHfQuantConfig
    ? await readJsonObjectFile(join(model.dir, HF_QUANT_CONFIG_FILE))
    : null

  const input: ModelCheckInput = {
    repository: model.repository ?? '',
    revision: model.revision ?? '',
    config_json: configJson,
    hf_quant_config_json: hfQuantConfigJson,
    files: model.files,
    gpu_id: options.gpuId,
  }
  const verdict = checkModelCompatibility(
    input,
    descriptor,
    gpus,
    hostMemAvailableBytes,
    options.kvCacheFreeGpuMemoryFraction
  )
  if (!verdict.verdict.ok) {
    const { code, message, details } = verdict.verdict.error
    throw new AtomicCoreError(code, message, details)
  }
  return verdict
}
