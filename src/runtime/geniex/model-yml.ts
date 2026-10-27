/**
 * The `geniex` block of a GenieX model's `model.yml` (openspec change `add-geniex-runtime`, task 6.2).
 * The core never writes it — the app and `atc` do — and reads it strictly: a plugin, device or chip
 * this core does not know is a model it cannot run (`GENIEX_VARIANT_UNSUPPORTED`), anything else
 * malformed is a broken file (`MODEL_LOAD_FAILED`).
 */

import { AtomicCoreError, GENIEX_CHIPS, GENIEX_DEVICES, GENIEX_PLUGINS } from '../../contracts/index.js'
import type { GeniexChip, GeniexDevice, GeniexPlugin, ModelYmlGeniex } from '../../contracts/index.js'

const broken = (why: string) => new AtomicCoreError('MODEL_LOAD_FAILED', `model.yml: geniex ${why}.`)
const unsupported = (why: string) =>
  new AtomicCoreError('GENIEX_VARIANT_UNSUPPORTED', `This core does not run GenieX models ${why}.`)

const text = (block: Record<string, unknown>, key: string): string => {
  const value = block[key]
  if (typeof value !== 'string' || value.trim() === '') throw broken(`has no ${key}`)
  return value
}

const optionalText = (block: Record<string, unknown>, key: string): string | undefined => {
  const value = block[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim() === '') throw broken(`has a ${key} that is not text`)
  return value
}

const flag = (block: Record<string, unknown>, key: string): boolean => {
  const value = block[key]
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw broken(`has a ${key} that is not true or false`)
  return value
}

/** A bare file name, as the model folder holds it. */
const FILE_NAME_RE = /^[^/\\]+$/
const fileName = (block: Record<string, unknown>, key: string, required: boolean): string | undefined => {
  const value = required ? text(block, key) : optionalText(block, key)
  if (value === undefined) return undefined
  const name = value.split('/').at(-1) ?? ''
  if (!FILE_NAME_RE.test(name) || name === '..' || value.split('/').includes('..'))
    throw broken(`has a ${key} that is not a file of the repository`)
  return value
}

export function readGeniexBlock(doc: Record<string, unknown>): ModelYmlGeniex {
  const raw = doc['geniex']
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw broken('is missing')
  const block = raw as Record<string, unknown>
  const plugin = text(block, 'plugin')
  if (!GENIEX_PLUGINS.some((known) => known === plugin)) throw unsupported(`with the "${plugin}" plugin`)
  const backend = text(block, 'backend')
  if (!GENIEX_DEVICES.some((known) => known === backend)) throw unsupported(`on the "${backend}" device`)
  const chip = optionalText(block, 'chip')
  if (plugin === 'qairt') {
    if (chip === undefined) throw broken('names no chip for an AI Hub bundle')
    if (!GENIEX_CHIPS.some((known) => known === chip)) throw unsupported(`for the "${chip}" chip`)
    if (backend !== 'npu')
      throw unsupported(`that run an AI Hub bundle on the "${backend}" device: bundles run on the NPU only`)
  } else if (chip !== undefined) throw broken('names a chip for a GGUF model')
  const context = block['context_length']
  if (typeof context !== 'number' || !Number.isSafeInteger(context) || context < 1)
    throw broken('has a context_length that is not a positive whole number')
  const source = block['source']
  if (source !== 'curated' && source !== 'huggingface')
    throw broken('has a source that is not curated or huggingface')
  const file = fileName(block, 'file', plugin === 'llama_cpp')
  const mmproj = fileName(block, 'mmproj', false)
  const repo = optionalText(block, 'repo')
  const revision = optionalText(block, 'revision')
  const bundleUrl = optionalText(block, 'bundle_url')
  const precision = optionalText(block, 'precision')
  if (bundleUrl !== undefined && !/^https:\/\/\S+$/.test(bundleUrl))
    throw broken('has a bundle_url that is not https://')
  return {
    model_id: text(block, 'model_id'),
    variant_id: text(block, 'variant_id'),
    plugin: plugin as GeniexPlugin,
    backend: backend as GeniexDevice,
    ...(chip !== undefined ? { chip: chip as GeniexChip } : {}),
    ...(repo !== undefined ? { repo } : {}),
    ...(revision !== undefined ? { revision } : {}),
    ...(file !== undefined ? { file } : {}),
    ...(mmproj !== undefined ? { mmproj } : {}),
    ...(bundleUrl !== undefined ? { bundle_url: bundleUrl } : {}),
    ...(precision !== undefined ? { precision } : {}),
    context_length: context,
    tools: flag(block, 'tools'),
    reasoning: flag(block, 'reasoning'),
    vision: flag(block, 'vision'),
    source,
  }
}
