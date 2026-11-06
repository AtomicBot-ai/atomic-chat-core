import { AtomicCoreError, type FastFlowLmOperation, type FastFlowLmHostReceipt } from '../contracts/index.js'

function invalid(): never {
  throw new AtomicCoreError(
    'MANAGED_HOST_STEP_INVALID',
    'The FastFlowLM host result or pending authorization is invalid.'
  )
}
function stepOf(op: FastFlowLmOperation) {
  if (op.state !== 'preparing-host' || !op.pending_host_step) return invalid()
  const step = op.pending_host_step
  if (
    !['windows.install-amd-npu', 'linux.install-amd-npu', 'linux.configure-runtime-memlock'].includes(
      step.action
    ) ||
    !/^[-a-zA-Z0-9_]{1,128}$/.test(step.step_id)
  )
    return invalid()
  return step
}
/** Write text verbatim, exclusively create the request file, and pass sha256 separately to the trusted executable. */
export async function fastFlowLmHostRequest(op: FastFlowLmOperation, dataFolder: string) {
  const step = stepOf(op)
  if (op.reason === 'cancellation-requested' || op.revision !== step.expected_operation_revision)
    return invalid()
  const text = JSON.stringify({
    schema_version: 1,
    ...step,
    operation_id: op.operation_id,
    data_folder: dataFolder,
  })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return {
    text,
    sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''),
  }
}
/** Convert the elevated result only after binding it to the pending authorization. */
export function fastFlowLmHostReceipt(
  op: FastFlowLmOperation,
  receiptId: string,
  result: unknown
): FastFlowLmHostReceipt {
  const s = stepOf(op)
  if (!result || typeof result !== 'object') return invalid()
  const r = result as Record<string, unknown>
  if (
    r.schema_version !== 1 ||
    r.error_code !== null ||
    r.operation_id !== op.operation_id ||
    r.expected_operation_revision !== s.expected_operation_revision ||
    r.step_id !== s.step_id ||
    r.nonce !== s.nonce ||
    r.recipe_id !== s.recipe_id ||
    r.recipe_digest !== s.recipe_digest ||
    r.parameters_digest !== s.parameters_digest ||
    typeof r.log_tail !== 'string'
  )
    return invalid()
  const windows = s.action === 'windows.install-amd-npu',
    code = r.exit_code,
    outcome = r.outcome
  switch (outcome) {
    case 'completed':
      if (code !== 0) return invalid()
      break
    case 'failed':
      if (code !== null && (!Number.isSafeInteger(code) || code === 0)) return invalid()
      break
    case 'declined':
      if (!windows || code !== 1223) return invalid()
      break
    case 'reboot-required':
      if (code !== (windows ? 3010 : 0)) return invalid()
      break
    case 'relogin-required':
      if (windows || code !== 0) return invalid()
      break
    case 'service-restart-required': {
      const a = r.activation as Record<string, unknown> | null
      if (
        windows ||
        code !== 0 ||
        !a ||
        a.kind !== 'restart-service' ||
        !s.parameters.runtime_service ||
        a.unit !== s.parameters.runtime_service ||
        a.account !== s.parameters.runtime_account ||
        a.scope !== (s.parameters.runtime_mode === 'user-service' ? 'user' : 'system')
      )
        return invalid()
      break
    }
    default:
      return invalid()
  }
  return {
    receipt_id: receiptId,
    step_id: s.step_id,
    nonce: s.nonce,
    expected_operation_revision: s.expected_operation_revision,
    recipe_digest: s.recipe_digest,
    parameters_digest: s.parameters_digest,
    outcome,
    log_tail: r.log_tail.slice(-16384),
  }
}
