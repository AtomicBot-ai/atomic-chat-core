/**
 * The `foundry_local` block of a Foundry Local model's `model.yml` (openspec change
 * `add-foundry-local`, task 6.2). The core never writes it — the app's installer does — and reads it
 * strictly: an accelerator or device this core does not know is a variant it cannot run
 * (`FOUNDRY_LOCAL_VARIANT_UNSUPPORTED`), anything else malformed is a broken file (`MODEL_LOAD_FAILED`).
 */

import {
  AtomicCoreError,
  FOUNDRY_LOCAL_DEVICES,
  FOUNDRY_LOCAL_EXECUTION_PROVIDERS,
} from '../../contracts/index.js'
import type {
  FoundryLocalDevice,
  FoundryLocalExecutionProvider,
  ModelYmlFoundryLocal,
} from '../../contracts/index.js'

const broken = (why: string) => new AtomicCoreError('MODEL_LOAD_FAILED', `model.yml: foundry_local ${why}.`)

const text = (block: Record<string, unknown>, key: string): string => {
  const value = block[key]
  if (typeof value !== 'string' || value.trim() === '') throw broken(`has no ${key}`)
  return value
}

const optionalText = (block: Record<string, unknown>, key: string): string | undefined => {
  const value = block[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value === '') throw broken(`has a ${key} that is not text`)
  return value
}

const flag = (block: Record<string, unknown>, key: string): boolean => {
  const value = block[key]
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw broken(`has a ${key} that is not true or false`)
  return value
}

export function readFoundryLocalBlock(doc: Record<string, unknown>): ModelYmlFoundryLocal {
  const raw = doc['foundry_local']
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw broken('is missing')
  const block = raw as Record<string, unknown>
  const executionProvider = text(block, 'execution_provider')
  if (!FOUNDRY_LOCAL_EXECUTION_PROVIDERS.some((known) => known === executionProvider))
    throw new AtomicCoreError(
      'FOUNDRY_LOCAL_VARIANT_UNSUPPORTED',
      `This core does not run Foundry Local variants on the "${executionProvider}" accelerator.`
    )
  const device = text(block, 'device')
  if (!FOUNDRY_LOCAL_DEVICES.some((known) => known === device))
    throw new AtomicCoreError(
      'FOUNDRY_LOCAL_VARIANT_UNSUPPORTED',
      `This core does not run Foundry Local variants on a "${device}" device.`
    )
  const context = block['context_length']
  if (context !== undefined && (typeof context !== 'number' || !Number.isSafeInteger(context) || context < 1))
    throw broken('has a context_length that is not a positive whole number')
  const assetId = optionalText(block, 'asset_id')
  const assetVersion = optionalText(block, 'asset_version')
  const reasoningStart = optionalText(block, 'reasoning_start')
  const reasoningEnd = optionalText(block, 'reasoning_end')
  return {
    model_id: text(block, 'model_id'),
    variant_id: text(block, 'variant_id'),
    execution_provider: executionProvider as FoundryLocalExecutionProvider,
    device: device as FoundryLocalDevice,
    ...(assetId !== undefined ? { asset_id: assetId } : {}),
    ...(assetVersion !== undefined ? { asset_version: assetVersion } : {}),
    ...(context !== undefined ? { context_length: context } : {}),
    tools: flag(block, 'tools'),
    reasoning: flag(block, 'reasoning'),
    ...(reasoningStart !== undefined ? { reasoning_start: reasoningStart } : {}),
    ...(reasoningEnd !== undefined ? { reasoning_end: reasoningEnd } : {}),
  }
}
