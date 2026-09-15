/**
 * `model.yml` codec. The app writes it with serde_yaml (`write_yaml`) and reads it back with
 * `read_yaml`; the shape is `ModelYml` in `contracts/model-yml.ts`. Unknown keys are preserved on
 * round-trip (PLAN.md §5.1); known keys are written in the app's order, `undefined` ones omitted.
 */

import { parse, stringify } from 'yaml'
import { MODEL_YML_KEY_ORDER } from '../contracts/index.js'
import type { ModelYml } from '../contracts/index.js'

export class ModelYmlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelYmlError'
  }
}

/** A parsed file: the typed fields plus whatever else was in it. */
export type ModelYmlDocument = ModelYml & Record<string, unknown>

const KNOWN = new Set<string>(MODEL_YML_KEY_ORDER)

export function parseModelYml(text: string): ModelYmlDocument {
  let raw: unknown
  try {
    raw = parse(text)
  } catch (e) {
    throw new ModelYmlError(`invalid YAML: ${(e as Error).message}`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new ModelYmlError('model.yml is not a mapping')
  const doc = raw as Record<string, unknown>
  if (typeof doc['model_path'] !== 'string') throw new ModelYmlError('model.yml: missing model_path')
  const name = typeof doc['name'] === 'string' ? doc['name'] : undefined
  return {
    ...doc,
    model_path: doc['model_path'],
    name: name ?? '',
    size_bytes: numberOr(doc['size_bytes'], 0),
  } as ModelYmlDocument
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** Anything with a `model_path`; other known keys are optional and may be `undefined` (omitted). */
export type ModelYmlInput = { model_path: string } & { [key: string]: unknown }

/** Known keys first in the app's order, then unknown keys in their original order. */
export function serializeModelYml(doc: ModelYmlInput): string {
  const ordered: Record<string, unknown> = {}
  for (const key of MODEL_YML_KEY_ORDER) {
    const v = (doc as Record<string, unknown>)[key]
    if (v !== undefined) ordered[key] = v
  }
  for (const [key, v] of Object.entries(doc)) {
    if (!KNOWN.has(key) && v !== undefined) ordered[key] = v
  }
  return stringify(ordered, { lineWidth: 0 })
}

/** Rename the model id inside the path fields, as `update()` does when a model is renamed. */
export function renameModelPaths(
  doc: ModelYmlDocument,
  modelsRootPrefix: string,
  oldId: string,
  newId: string
): ModelYmlDocument {
  const from = `${modelsRootPrefix}/${oldId}`
  const to = `${modelsRootPrefix}/${newId}`
  const swap = (p: string | undefined) => (p === undefined ? undefined : p.replace(from, to))
  const out: ModelYmlDocument = { ...doc, model_path: swap(doc.model_path) as string }
  if (doc.mmproj_path !== undefined) out.mmproj_path = swap(doc.mmproj_path) as string
  return out
}
