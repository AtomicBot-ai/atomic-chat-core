import { expect, it } from 'vitest'
import wire from '../../test/fixtures/fastflowlm/control-v1.json' with { type: 'json' }
import type { FastFlowLmOperation } from '../contracts/index.js'
import { fastFlowLmHostRequest, fastFlowLmHostReceipt } from './fastflowlm-host-step.js'
const op = wire.operation as FastFlowLmOperation
const step = op.pending_host_step!
const result = {
  ...step,
  operation_id: op.operation_id,
  schema_version: 1,
  error_code: null,
  log_tail: '',
  exit_code: 0,
  outcome: 'completed',
}
it('hashes exactly the UTF-8 request written before elevation and refuses cancelled launches', async () => {
  const { text, sha256 } = await fastFlowLmHostRequest(op, '/tmp/дата')
  expect(sha256).toBe('0b15f916c0a38b6433ead9d52e71c1b3585a3169589fed57228baa031b48f5bf')
  expect(JSON.parse(text)).toEqual({
    ...step,
    operation_id: op.operation_id,
    data_folder: '/tmp/дата',
    schema_version: 1,
  })
  await expect(fastFlowLmHostRequest({ ...op, reason: 'cancellation-requested' }, '/tmp')).rejects.toThrow()
})
it('binds receipts to the original authorization, result and activation target', () => {
  expect(fastFlowLmHostReceipt(op, 'receipt', result)).toMatchObject({
    nonce: step.nonce,
    outcome: 'completed',
  })
  for (const override of [
    { operation_id: 'wrong' },
    { expected_operation_revision: -1 },
    { parameters_digest: '' },
    { step_id: 'wrong' },
    { nonce: '' },
    { error_code: 'MANAGED_HOST_STEP_INVALID' },
    { outcome: 'invented' },
    { exit_code: 4 },
    { outcome: 'service-restart-required', activation: {} },
  ])
    expect(() => fastFlowLmHostReceipt(op, 'receipt', { ...result, ...override })).toThrow()
})
