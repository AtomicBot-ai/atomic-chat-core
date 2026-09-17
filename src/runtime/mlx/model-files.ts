/**
 * What an MLX load reads from a model folder: the trained context, a mis-named first shard to heal,
 * and a drafter already on disk.
 *
 * Ported from: extensions/mlx-extension/src/index.ts (`resolveModelMaxCtxTrain`,
 * `repairLegacyShardName`, `resolveLocalDraftDir`).
 */

import { readdir, readFile, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DataLayout } from '../../config/index.js'
import type { ModelRegistry, ModelYmlDocument } from '../../models/index.js'
import { planMlxShardRepair, repointLegacyWeightPath } from './shard-repair.js'

/** A model path's folder: the path itself when it is a folder, its parent otherwise. */
export async function mlxModelDir(modelPath: string): Promise<string> {
  const info = await stat(modelPath).catch(() => undefined)
  return info?.isDirectory() ? modelPath : dirname(modelPath)
}

/**
 * `max_position_embeddings` from `config.json`, or the nested `text_config` one Hugging Face
 * VLM/omni configs use. `undefined` when the file or the key is missing or not a positive number.
 */
export async function readMlxMaxCtxTrain(modelPath: string): Promise<number | undefined> {
  try {
    const config = JSON.parse(await readFile(join(await mlxModelDir(modelPath), 'config.json'), 'utf8')) as {
      max_position_embeddings?: unknown
      text_config?: { max_position_embeddings?: unknown }
    }
    const candidate = config?.max_position_embeddings ?? config?.text_config?.max_position_embeddings
    const parsed =
      typeof candidate === 'number' ? candidate : candidate != null ? parseInt(String(candidate), 10) : NaN
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Rename a first shard stored as `model.safetensors` to the name its index expects, and repoint
 * `model.yml`. Returns the document to load from; any failure leaves everything as it was, so the
 * load reports its own error.
 */
export async function repairLegacyShardName(
  registry: ModelRegistry,
  modelId: string,
  yml: ModelYmlDocument,
  warn: (message: string) => void = () => {}
): Promise<ModelYmlDocument> {
  try {
    const { modelPath } = registry.resolvePaths(yml)
    const modelDir = modelPath.endsWith('.safetensors') ? dirname(modelPath) : modelPath
    const index = JSON.parse(await readFile(join(modelDir, 'model.safetensors.index.json'), 'utf8')) as {
      weight_map?: unknown
    }
    const plan = planMlxShardRepair(index?.weight_map, await readdir(modelDir))
    if (!plan) return yml
    await rename(join(modelDir, plan.from), join(modelDir, plan.to))
    const repaired: ModelYmlDocument = {
      ...yml,
      model_path: repointLegacyWeightPath(yml.model_path, plan.to),
      ...(yml.mmproj_path ? { mmproj_path: repointLegacyWeightPath(yml.mmproj_path, plan.to) } : {}),
    }
    await registry.write(modelId, repaired)
    warn(`Repaired mis-named MLX shard in ${modelDir}: ${plan.from} -> ${plan.to}`)
    return repaired
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') warn(`MLX shard-name repair failed: ${String(e)}`)
    return yml
  }
}

/** Where downloaded drafters live: `<data>/mlx/draft-models/<owner>/<repo>`. */
export function mlxDraftModelsDir(layout: DataLayout): string {
  return join(layout.root, 'mlx', 'draft-models')
}

/**
 * A drafter already on disk: imported as a model (`mlx/models/<owner_repo>`) or downloaded as a
 * draft (`mlx/draft-models/<owner>/<repo>`), with a `config.json` and some safetensors weights.
 */
export async function resolveLocalDraftDir(layout: DataLayout, repo: string): Promise<string | undefined> {
  const candidates = [
    join(layout.root, 'mlx', 'models', repo.split('/').join('_')),
    join(mlxDraftModelsDir(layout), ...repo.split('/')),
  ]
  for (const dir of candidates) {
    const entries = await readdir(dir).catch(() => undefined)
    if (!entries?.includes('config.json')) continue
    if (entries.some((entry) => /\.safetensors$/i.test(entry))) return dir
  }
  return undefined
}
