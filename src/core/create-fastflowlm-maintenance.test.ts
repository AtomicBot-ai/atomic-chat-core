import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { CoreClient } from '../client/index.js'
import { createCore, data, useCoreHarness } from '../../test/helpers/core-harness.js'
import { linuxFastFlowLmPci } from '../../test/helpers/fastflowlm-installation.js'
useCoreHarness()
it('releases replacement maintenance after an initial installation is rolled back to absence', async () => {
  const core = await createCore({
    platform: 'linux',
    hardware: { fastFlowLm: { fs: linuxFastFlowLmPci() } },
    foundryLocalHost: { arch: 'x64', glibcVersion: '2.39' },
  })
  const client = new CoreClient({ baseUrl: core.control.url, token: core.controlToken })
  const request = { request_id: 'initial-rollback', model_id: 'qwen3-0.6b-npu2', kind: 'replace' as const }
  const guard = await client.beginFastFlowLmMaintenance(request)
  expect(guard.ready_to_mutate).toBe(true)
  // Existing but incomplete bytes must keep the guard held; only actual absence represents this rollback.
  const dir = join(data.layout.provider('fastflowlm').modelsDir, request.model_id)
  await mkdir(dir, { recursive: true })
  await expect(client.completeFastFlowLmMaintenance(guard.operation_id)).rejects.toMatchObject({
    code: 'FASTFLOWLM_INVALID_INSTALLATION',
  })
  await rm(dir, { recursive: true })
  expect(await client.completeFastFlowLmMaintenance(guard.operation_id)).toMatchObject({ state: 'completed' })
  expect(await client.beginFastFlowLmMaintenance(request)).toEqual({
    operation_id: guard.operation_id,
    ready_to_mutate: false,
  })
})
