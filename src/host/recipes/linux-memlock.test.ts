import { expect, it } from 'vitest'
import { linuxMemlockTarget } from './linux-memlock.js'
import { canonicalDigest } from '../../runtime/environment/index.js'
import { RUNTIME_MEMLOCK, RUNTIME_MEMLOCK_DIGEST } from '../../runtime/fastflowlm/environment/index.js'
import type { HostStepRequest } from './request-file.js'
const parameters = {
  runtime_account: 'lex',
  runtime_mode: 'interactive',
  runtime_service: null,
  runtime_process: { pid: 4207, start_ticks: '123', boot_id: '11111111-1111-1111-1111-111111111111' },
}
const request = {
  recipe_id: RUNTIME_MEMLOCK.recipe_id,
  recipe_digest: RUNTIME_MEMLOCK_DIGEST,
  parameters,
  parameters_digest: canonicalDigest(parameters),
} as unknown as HostStepRequest
it('only accepts the fixed built-in memory policy and a bound runtime identity', () => {
  expect(linuxMemlockTarget(request)).toEqual(parameters)
  for (const p of [
    { ...parameters, bytes: 'unlimited' },
    { ...parameters, runtime_account: 'root' },
    { ...parameters, runtime_service: '../bad.service' },
    { ...parameters, runtime_process: { ...parameters.runtime_process, pid: 1 } },
  ]) {
    expect(
      linuxMemlockTarget({ ...request, parameters: p, parameters_digest: canonicalDigest(p) })
    ).toBeNull()
  }
  expect(linuxMemlockTarget({ ...request, recipe_digest: canonicalDigest({}) })).toBeNull()
  expect(linuxMemlockTarget({ ...request, parameters_digest: canonicalDigest({}) })).toBeNull()
})

import { createHash } from 'node:crypto'
import { vi } from 'vitest'
import { executeHostStep, type HostStepExecutorDeps } from './executor.js'
import { fastFlowLmHostReceipt, fastFlowLmHostRequest } from '../../client/index.js'
import type { FastFlowLmOperation } from '../../contracts/index.js'
it('round trips the SDK authorization through the executor and rejects a changed launch digest', async () => {
  const step = {
    ...request,
    action: 'linux.configure-runtime-memlock',
    step_id: 'memory',
    nonce: 'nonce',
    expected_operation_revision: 3,
  }
  const operation = {
    operation_id: 'operation',
    revision: 3,
    state: 'preparing-host',
    reason: null,
    pending_host_step: step,
  } as unknown as FastFlowLmOperation
  const bound = await fastFlowLmHostRequest(operation, '/data')
  const configureRuntimeMemlock = vi.fn(async () => {})
  const deps = {
    readRequest: async () => bound.text,
    writeResult: vi.fn(async () => {}),
    now: () => 1,
    configureRuntimeMemlock,
  } as unknown as HostStepExecutorDeps
  expect(bound.sha256).toBe(createHash('sha256').update(bound.text).digest('hex'))
  const result = await executeHostStep('/private/memory.request.json', deps, bound.sha256)
  expect(result).toMatchObject({ outcome: 'completed', error_code: null })
  expect(configureRuntimeMemlock).toHaveBeenCalledExactlyOnceWith(parameters)
  expect(fastFlowLmHostReceipt(operation, 'receipt', result)).toMatchObject({
    outcome: 'completed',
    step_id: 'memory',
  })
  configureRuntimeMemlock.mockRejectedValueOnce(Error('Runtime process changed after approval.'))
  const failed = await executeHostStep('/private/memory.request.json', deps, bound.sha256)
  expect(failed).toMatchObject({
    outcome: 'failed',
    error_code: null,
    log_tail: 'Runtime process changed after approval.',
  })
  expect(fastFlowLmHostReceipt(operation, 'failed', failed).outcome).toBe('failed')
  configureRuntimeMemlock.mockClear()
  expect(await executeHostStep('/private/memory.request.json', deps, '0'.repeat(64))).toMatchObject({
    error_code: 'MANAGED_HOST_STEP_INVALID',
  })
  expect(configureRuntimeMemlock).not.toHaveBeenCalled()
})
