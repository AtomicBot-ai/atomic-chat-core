/**
 * `POST /models/foundry-local/check` (openspec change `add-foundry-local`, task 6.5): whether a variant
 * would run here, from what core already knows — the platform, the installed build, the last
 * accelerators probe and whether the machine has an NPU. Never the network.
 */

import { AtomicCoreError, FOUNDRY_LOCAL_EXECUTION_PROVIDERS } from '../../contracts/index.js'
import type {
  FoundryLocalAccelerator,
  FoundryLocalCheckRequest,
  FoundryLocalCheckResult,
  FoundryLocalExecutionProvider,
} from '../../contracts/index.js'
import { executionProvider } from './host/execution-providers.js'
import { variantRunsOn } from './runtime.js'

export interface FoundryLocalCheckFacts {
  platform: NodeJS.Platform
  arch: string
  /** A Foundry Local build is installed and active. */
  installed: boolean
  /** The last probe's accelerators, with core's record of what is prepared. */
  accelerators: readonly FoundryLocalAccelerator[]
  /** An NPU on this machine (`probeNpu`); `null` when unknown — the probe's list decides then. */
  npu: boolean | null
}

export function foundryLocalVerdict(
  facts: FoundryLocalCheckFacts,
  request: FoundryLocalCheckRequest
): FoundryLocalCheckResult {
  const known = FOUNDRY_LOCAL_EXECUTION_PROVIDERS.some((ep) => ep === request.execution_provider)
  if (!known)
    return {
      verdict: 'platform-unsupported',
      reason: `This core runs no Foundry Local variant on the "${request.execution_provider}" accelerator.`,
      accelerator: null,
    }
  const short = request.execution_provider as FoundryLocalExecutionProvider
  const ep = executionProvider(short)
  const accelerator = ep.register
  if (!variantRunsOn(facts.platform, facts.arch, short))
    return {
      verdict: 'platform-unsupported',
      reason: `${short.toUpperCase()} variants do not run on ${facts.platform} ${facts.arch}.`,
      accelerator,
    }
  if (!facts.installed)
    return {
      verdict: 'engine-not-installed',
      reason: 'Foundry Local is not installed on this computer.',
      accelerator,
    }
  if (accelerator === null) return { verdict: 'ok', reason: null, accelerator: null }
  if (request.device === 'npu' && facts.npu === false)
    return { verdict: 'accelerator-unavailable', reason: 'This computer has no NPU.', accelerator }
  const found = facts.accelerators.find((candidate) => candidate.name === accelerator)
  if (!found)
    return {
      verdict: 'accelerator-unavailable',
      reason: `Foundry Local does not offer ${accelerator} on this computer.`,
      accelerator,
    }
  if (!found.prepared)
    return {
      verdict: 'accelerator-not-prepared',
      reason: `${accelerator} is not prepared yet; prepare it on the Foundry Local page.`,
      accelerator,
    }
  return { verdict: 'ok', reason: null, accelerator }
}

/** The request body, strictly: the accelerator and the device as text, nothing else. */
export function parseFoundryLocalCheckRequest(body: unknown): FoundryLocalCheckRequest {
  const invalid = (why: string): never => {
    throw new AtomicCoreError('INVALID_ARGUMENT', why)
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return invalid('The request body must be a JSON object.')
  const record = body as Record<string, unknown>
  const extra = Object.keys(record).filter((key) => key !== 'execution_provider' && key !== 'device')
  if (extra.length > 0) invalid(`The request has fields this core does not know: ${extra.sort().join(', ')}.`)
  const { execution_provider: executionProvider, device } = record
  if (typeof executionProvider !== 'string' || executionProvider === '')
    invalid('execution_provider is required.')
  if (typeof device !== 'string' || device === '') invalid('device is required.')
  return { execution_provider: executionProvider as string, device: device as string }
}
