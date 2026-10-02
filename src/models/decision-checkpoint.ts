/**
 * What sits at a decision model path: a GGUF file, a laya Hugging Face checkpoint folder (complete
 * or not), or nothing. The engine converts a folder itself (`-m DIR`); the core only has to tell the
 * cases apart before a start, so an incomplete download fails with the files it lacks instead of a
 * load error from the engine.
 */

import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { DECISION_CHECKPOINT_FILES, missingDecisionCheckpointFiles } from './gguf/index.js'

export type DecisionModelSource =
  | { kind: 'file' }
  /** `missing`: required files the folder lacks, empty when it is complete. */
  | { kind: 'checkpoint-dir'; missing: string[] }
  | { kind: 'none' }

const isFile = (path: string): Promise<boolean> =>
  stat(path).then(
    (s) => s.isFile(),
    () => false
  )

export async function inspectDecisionModelPath(path: string): Promise<DecisionModelSource> {
  const info = await stat(path).catch(() => undefined)
  if (!info) return { kind: 'none' }
  if (info.isFile()) return { kind: 'file' }
  if (!info.isDirectory()) return { kind: 'none' }
  const present = new Set<string>()
  for (const file of DECISION_CHECKPOINT_FILES)
    if (await isFile(join(path, ...file.split('/')))) present.add(file)
  return { kind: 'checkpoint-dir', missing: missingDecisionCheckpointFiles(present) }
}

/**
 * A folder that is a laya checkpoint: it has `rl_agent_config.json`. An incomplete one still counts,
 * so a half-downloaded decision model is not mistaken for something else.
 */
export async function isDecisionCheckpointDir(path: string): Promise<boolean> {
  const source = await inspectDecisionModelPath(path)
  return source.kind === 'checkpoint-dir' && !source.missing.includes('rl_agent_config.json')
}
