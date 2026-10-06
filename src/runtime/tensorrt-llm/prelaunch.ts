/**
 * The pre-launch check `TensorrtLlmRuntime.load` runs once `deps.model` has resolved an installed
 * model (task 2.16, spec `tensorrt-llm-models`, "Проверка файлов при загрузке"): every file
 * `model.yml` recorded is still on disk at its declared size — a shard deleted after download is
 * refused by name, the way a corrupt GGUF already is for llama.cpp (`MODEL_FILE_NOT_FOUND`/
 * `MODEL_FILE_CORRUPT`, `../llamacpp/load-plan.ts`'s own convention, reused here) — and the
 * compatibility verdict is recomputed against `config.json` and `hf_quant_config.json` exactly as
 * they sit in the model's directory right now, not as `model.yml` last recorded them, and against
 * the card this load is about to use (its `gpu_id` is passed in, already resolved and possibly
 * substituted by the caller — this never re-picks a card).
 *
 * `verifyModelFilesAndCompatibility` below is everything above the memory line only — files,
 * architecture, format, compute capability — and returns a `ResolvedCheckpoint`
 * (`compatibility.ts`) rather than a final verdict, on purpose: memory is checked separately, later,
 * by `checkModelMemory` (re-exported from `compatibility.ts`) called from `runtime.ts`'s
 * `beforeCreate` hook, once `stopPrevious` has actually freed the card (task 2.16w round 1, finding
 * 1 (Critical) — reading free memory here, before eviction, would refuse a same-card model switch
 * outright on a single-GPU host). No container exists before either call; a failure in either never
 * creates one.
 *
 * `hf_quant_config.json` is read whenever it exists on disk (finding 4), independent of whether
 * `model.yml`'s own `files` list happens to mention it — `model.yml` is a record the app/CLI wrote
 * when the download finished, and can be stale or incomplete in ways the file itself on disk is not.
 *
 * Direct `node:fs/promises`, no injected `exec`/`readFile`: reading the model's own checkpoint
 * directory is local disk I/O, the same convention `model-dir.ts` already uses for `model.yml`
 * itself — nothing here is a shell command or a network call that would need faking on a non-Linux
 * test host.
 */
import { open, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import type { ErrorBody, GpuFacts, RuntimeDescriptor } from '../../contracts/index.js'
import {
  checkCheckpointFiles,
  normalizeWeightNames,
  safetensorsHeaderLength,
  safetensorsTensorNames,
  weightSafetensorsFiles,
} from '../managed-models/compatibility.js'
import type {
  CheckpointFile,
  HostMemory,
  ManagedCheckEngine,
  ModelCheckInput,
  ResolvedCheckpoint,
} from '../managed-models/compatibility.js'
import type { TensorrtLlmModel } from './model-dir.js'
import type { JsonObject } from '../managed-models/quant-format.js'

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
        `The model is missing a file recorded in model.yml: ${file.path}`,
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

/**
 * The tensor names in one `.safetensors` file's own header (8-byte little-endian length, then JSON):
 * what the file really holds, unlike `model.safetensors.index.json`, which a repository can ship
 * stale or copied from another model (PrimeIntellect/GLM-0.5B: an 18k-name index over a 429-tensor
 * file). `undefined` for a file that does not shape up as safetensors — the shape checks are then
 * skipped, never failed on a header this core cannot read.
 */
async function tensorNamesOnDisk(path: string): Promise<string[] | undefined> {
  const handle = await open(path, 'r').catch(() => undefined)
  if (handle === undefined) return undefined
  try {
    const prefix = Buffer.alloc(8)
    if ((await handle.read(prefix, 0, 8, 0)).bytesRead !== 8) return undefined
    const length = safetensorsHeaderLength(prefix)
    if (length === undefined) return undefined
    const header = Buffer.alloc(length)
    if ((await handle.read(header, 0, length, 8)).bytesRead !== length) return undefined
    return safetensorsTensorNames(JSON.parse(header.toString('utf8')))
  } catch {
    return undefined
  } finally {
    await handle.close()
  }
}

/** Every weight file's tensor names, folded; `undefined` when there is none or any header is unreadable. */
async function weightNamesOnDisk(
  dir: string,
  files: readonly CheckpointFile[]
): Promise<string[] | undefined> {
  const weights = weightSafetensorsFiles(files)
  if (weights.length === 0) return undefined
  const names: string[] = []
  for (const file of weights) {
    const own = await tensorNamesOnDisk(safeJoin(dir, file.path))
    if (own === undefined) return undefined
    names.push(...own)
  }
  return normalizeWeightNames(names)
}

export interface VerifyModelFilesOptions {
  /** The card this load is about to use; already resolved (and possibly substituted) by the caller. */
  gpuId: string
  /** The engine's hooks for the shared check (its memory rule, its checkpoint quirks). */
  engine: ManagedCheckEngine
}

/**
 * The pre-`stopPrevious` half of the pre-launch check: files, architecture, format and compute
 * capability — never memory (see the file banner). Throws `MODEL_FILE_NOT_FOUND`/`MODEL_FILE_CORRUPT`
 * for a missing or resized checkpoint file, or the pure check's own error
 * (`MODEL_INCOMPATIBLE`/`MANAGED_METADATA_INVALID`/`MANAGED_PREREQUISITE_BLOCKED`) for a checkpoint
 * that no longer checks out. On success, returns the `ResolvedCheckpoint` `checkModelMemory` needs
 * for the memory half — including `config.json`'s own verified `architectures`, which is what
 * `runtime.ts` now looks the descriptor's `model_families` entry up by (finding 5), never
 * `model.yml`'s possibly-stale copy.
 */
export async function verifyModelFilesAndCompatibility(
  model: Pick<TensorrtLlmModel, 'dir' | 'repository' | 'revision' | 'files'>,
  descriptor: RuntimeDescriptor,
  gpus: readonly GpuFacts[],
  hostMemory: HostMemory,
  options: VerifyModelFilesOptions
): Promise<ResolvedCheckpoint> {
  await assertFilesOnDisk(model.dir, model.files)

  const configJson = await readJsonObjectFile(join(model.dir, CONFIG_FILE))
  if (configJson === null) {
    throw new AtomicCoreError(
      'MODEL_FILE_NOT_FOUND',
      'The model has no config.json in its directory.',
      join(model.dir, CONFIG_FILE)
    )
  }
  // Read whenever the file is actually there, independent of model.yml's own files list (finding 4).
  const hfQuantConfigJson = await readJsonObjectFile(join(model.dir, HF_QUANT_CONFIG_FILE))
  // The same tensor names the download-time check gets from the app, so a checkpoint downloaded
  // before that check knew to look (or by an older app) is refused here, before any container.
  const weightNames = await weightNamesOnDisk(model.dir, model.files)

  const input: ModelCheckInput = {
    repository: model.repository ?? '',
    revision: model.revision ?? '',
    config_json: configJson,
    hf_quant_config_json: hfQuantConfigJson,
    files: model.files,
    gpu_id: options.gpuId,
    ...(weightNames === undefined ? {} : { weight_names: weightNames }),
  }
  const result = checkCheckpointFiles(input, descriptor, gpus, hostMemory, options.engine)
  if (!result.ok) {
    // `FilesCheckResult`'s own type guarantees `result.verdict.verdict` is the failed branch here.
    const { code, message, details } = (result.verdict.verdict as { ok: false; error: ErrorBody }).error
    throw new AtomicCoreError(code, message, details)
  }
  return result.resolved
}
