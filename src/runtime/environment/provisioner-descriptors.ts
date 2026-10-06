/**
 * Which runtime descriptor a host recipe works with, at each moment of an operation (design D7 of
 * change `add-tensorrt-llm-linux`) — shared by the Linux and the Windows provisioner, which must agree
 * on it exactly (moved out of `linux-provisioner.ts`, change `add-tensorrt-llm-windows`, task 2.3).
 *
 * Before the consent, a probe plans with the descriptor the operation's last plan or its request
 * named, when this core has it cached, otherwise the newest one it can get; the plan says which, so
 * the consent covers the real one. Once the user consented, only the consented descriptor, from the
 * cache — never a newer one: a plan naming another descriptor is a new download and has to be
 * approved again. Every effect after the consent works with exactly the descriptor the approved (or
 * carried) plan named; missing from the cache is a failure, not a reason to pick another.
 */
import { AtomicCoreError } from '../../contracts/index.js'
import type { ManagedBlocker, RuntimeDescriptor } from '../../contracts/index.js'
import { TENSORRT_LLM_ENGINE_ID, type RuntimeDescriptorProvider } from './descriptor-provider.js'
import type { PersistedOperation } from './store.js'

/**
 * Whose descriptor an operation plans with (change `add-vllm-runtime`, design D12): a runtime
 * target names its engine. An environment-only setup names none and keeps planning with
 * TensorRT-LLM's, as it always has.
 */
export function engineOfOperation(record: PersistedOperation): string {
  const target = record.machine.operation.target
  return target.kind === 'runtime' ? target.engine_id : TENSORRT_LLM_ENGINE_ID
}

const unavailable = (message: string, details?: string): ManagedBlocker => ({
  code: 'MANAGED_METADATA_INVALID',
  message,
  ...(details === undefined ? {} : { details }),
  reason: 'descriptor-unavailable',
})

/** The descriptor a probe plans with, or the blocker saying why there is none. */
export async function descriptorForProbe(
  descriptors: RuntimeDescriptorProvider,
  record: PersistedOperation
): Promise<{ descriptor: RuntimeDescriptor } | { blocker: ManagedBlocker }> {
  const consented = record.machine.consented?.descriptor_id ?? null
  if (consented !== null) {
    const pinned = await descriptors.forInstallation(consented)
    return pinned.kind === 'available'
      ? { descriptor: pinned.descriptor }
      : { blocker: unavailable(pinned.error.message, consented) }
  }
  const preferred = record.requirement_plan?.descriptor_id ?? record.request.descriptor_id ?? null
  if (preferred !== null) {
    const pinned = await descriptors.forInstallation(preferred)
    if (pinned.kind === 'available') return { descriptor: pinned.descriptor }
  }
  const latest = await descriptors.forNewSetup(engineOfOperation(record))
  if (latest.kind === 'available') return { descriptor: latest.descriptor }
  return { blocker: unavailable(latest.error.message, latest.error.details) }
}

/** The descriptor an effect after the consent works with: the approved plan's, from the cache, or a failure. */
export async function pinnedDescriptor(
  descriptors: RuntimeDescriptorProvider,
  record: PersistedOperation
): Promise<RuntimeDescriptor> {
  const id = record.machine.consented?.descriptor_id ?? record.requirement_plan?.descriptor_id ?? null
  if (id === null) {
    throw new AtomicCoreError(
      'MANAGED_METADATA_INVALID',
      'This operation has no approved runtime descriptor.'
    )
  }
  const pinned = await descriptors.forInstallation(id)
  if (pinned.kind !== 'available') {
    throw new AtomicCoreError('MANAGED_METADATA_INVALID', pinned.error.message, id)
  }
  return pinned.descriptor
}
