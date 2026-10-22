/**
 * The `litert_lm` block of a LiteRT-LM model's `model.yml` (openspec change `add-litert-lm-runtime`,
 * task 6.2). The core never writes it — the app and `atc` do — and reads it strictly: a backend or
 * NPU this core does not know is a variant it cannot run (`LITERT_LM_VARIANT_UNSUPPORTED`), anything
 * else malformed is a broken file (`MODEL_LOAD_FAILED`).
 */

import { AtomicCoreError, LITERT_LM_BACKENDS, LITERT_LM_NPUS } from '../../contracts/index.js'
import type { LiteRtLmBackendId, LiteRtLmNpu, ModelYmlLiteRtLm } from '../../contracts/index.js'

const broken = (why: string) => new AtomicCoreError('MODEL_LOAD_FAILED', `model.yml: litert_lm ${why}.`)
const unsupported = (why: string) =>
  new AtomicCoreError('LITERT_LM_VARIANT_UNSUPPORTED', `This core does not run LiteRT-LM variants ${why}.`)

const text = (block: Record<string, unknown>, key: string): string => {
  const value = block[key]
  if (typeof value !== 'string' || value.trim() === '') throw broken(`has no ${key}`)
  return value
}

const flag = (block: Record<string, unknown>, key: string): boolean => {
  const value = block[key]
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw broken(`has a ${key} that is not true or false`)
  return value
}

/** A bare file name, as the variant folder holds it. */
const FILE_NAME_RE = /^[^/\\]+$/

export function readLiteRtLmBlock(doc: Record<string, unknown>): ModelYmlLiteRtLm {
  const raw = doc['litert_lm']
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw broken('is missing')
  const block = raw as Record<string, unknown>
  const backend = text(block, 'backend')
  if (!LITERT_LM_BACKENDS.some((known) => known === backend)) throw unsupported(`on the "${backend}" backend`)
  const npu = block['npu']
  if (backend === 'npu') {
    if (typeof npu !== 'string' || npu === '') throw broken('names no npu for an NPU variant')
    if (!LITERT_LM_NPUS.some((known) => known === npu)) throw unsupported(`for the "${npu}" NPU`)
  } else if (npu !== undefined) throw broken(`names an npu for a ${backend} variant`)
  const file = text(block, 'file').split('/').at(-1) ?? ''
  if (!FILE_NAME_RE.test(file) || file === '..' || text(block, 'file').split('/').includes('..'))
    throw broken('has a file that is not a file of the repository')
  const context = block['context_length']
  if (context !== undefined && (typeof context !== 'number' || !Number.isSafeInteger(context) || context < 1))
    throw broken('has a context_length that is not a positive whole number')
  const source = block['source']
  if (source !== 'curated' && source !== 'huggingface')
    throw broken('has a source that is not curated or huggingface')
  return {
    model_id: text(block, 'model_id'),
    variant_id: text(block, 'variant_id'),
    backend: backend as LiteRtLmBackendId,
    ...(backend === 'npu' ? { npu: npu as LiteRtLmNpu } : {}),
    repo: text(block, 'repo'),
    revision: text(block, 'revision'),
    file: text(block, 'file'),
    ...(context !== undefined ? { context_length: context } : {}),
    tools: flag(block, 'tools'),
    reasoning: flag(block, 'reasoning'),
    vision: flag(block, 'vision'),
    source,
  }
}
