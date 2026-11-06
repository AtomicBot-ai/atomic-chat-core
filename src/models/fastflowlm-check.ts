import { buildFastFlowLmConfig, parseFastFlowLmDescriptor } from '../client/index.js'
import {
  AtomicCoreError,
  type FastFlowLmCheckResult,
  type FastFlowLmAccelerators,
  type ModelYmlFastFlowLm,
  type FastFlowLmRequirements,
} from '../contracts/index.js'
import { compareBuilds } from '../engine-builds/index.js'
import type { FastFlowLmRegistry } from './fastflowlm.js'

export async function checkFastFlowLmModel(
  body: unknown,
  registry: FastFlowLmRegistry,
  probe: () => Promise<Pick<FastFlowLmAccelerators, 'engine_version' | 'blockers' | 'reason' | 'ready'>>
): Promise<FastFlowLmCheckResult> {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !(
      'descriptor' in body ||
      ('model_id' in body && typeof body.model_id === 'string') ||
      ('path' in body && typeof body.path === 'string')
    )
  )
    throw new AtomicCoreError(
      'INVALID_ARGUMENT',
      'Specify one FastFlowLM descriptor, installed variant ID or path.'
    )
  let metadata: ModelYmlFastFlowLm | null = null
  let requirements: FastFlowLmRequirements | null = null
  let formatVersion: string | undefined
  const answer = (verdict: FastFlowLmCheckResult['verdict'], reason: string | null) => ({
    verdict,
    reason,
    requirements,
    metadata,
  })
  let descriptor
  try {
    if ('descriptor' in body) {
      descriptor = parseFastFlowLmDescriptor(body.descriptor)
      buildFastFlowLmConfig(descriptor)
    } else {
      const installed =
        'model_id' in body
          ? await registry.get(body.model_id as string)
          : await registry.byPath(body.path as string)
      metadata = installed.yml.fastflowlm
      descriptor = metadata
      formatVersion = installed.formatVersion
    }
    requirements = {
      minimum_flm_version: descriptor.minimum_flm_version,
      local_only_protocol: descriptor.local_only_protocol,
      npu_generation: descriptor.npu_generation,
    }
  } catch (e) {
    return answer('invalid-installation', e instanceof Error ? e.message : String(e))
  }
  if (formatVersion) {
    const nativeMinimum = 'flm-' + formatVersion + '-r1'
    if (compareBuilds('fastflowlm', { tag: nativeMinimum }, { tag: requirements.minimum_flm_version }) > 0)
      requirements.minimum_flm_version = nativeMinimum
  }
  const readiness = await probe()
  for (const blocker of ['platform-unsupported', 'xdna2-not-found']) {
    if (readiness.blockers.includes(blocker)) return answer('platform-unsupported', blocker)
  }
  const active = readiness.engine_version
  if (!active) return answer('engine-not-installed', 'Install a verified FastFlowLM build.')
  if (compareBuilds('fastflowlm', { tag: active }, { tag: requirements.minimum_flm_version }) < 0)
    return answer('requires-newer-engine', 'The installed FastFlowLM build is too old for this model.')
  if (!readiness.ready) return answer('environment-not-ready', readiness.reason)
  return answer('ok', null)
}
