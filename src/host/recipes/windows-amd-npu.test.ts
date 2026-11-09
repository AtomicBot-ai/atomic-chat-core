import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { canonicalDigest } from '../../runtime/environment/index.js'
import { windowsManifest } from '../../../test/helpers/flm-environment.js'
import { executeHostStep, type HostStepExecutorDeps } from './executor.js'
import { checkNpuCab, type NpuInstallerIo, installWindowsNpu } from './windows-amd-npu.js'

const target = 'PCI\\VEN_1022&DEV_17F0&SUBSYS_513717AA&REV_20\\4&1234&0&0041'
const io = (): NpuInstallerIo => ({
  state: vi.fn(async () => 'needed' as const),
  withStage: vi.fn(async (run) => run('stage')),
  download: vi.fn(async () => {}),
  verify: vi.fn(async () => {}),
  install: vi.fn(async () => 0),
})
function request() {
  const manifest = windowsManifest(),
    recipe = manifest.recipes[0]!
  const parameters = {
    runtime_account: 'HOST\\user',
    runtime_mode: 'interactive',
    runtime_service: null,
    manifest_id: manifest.manifest_id,
    manifest_digest: canonicalDigest(manifest),
    recipe_revision: recipe.revision,
    device_instance_id: target,
    environment_manifest: manifest,
  }
  return {
    schema_version: 1,
    step_id: 'step-1',
    operation_id: 'op',
    nonce: 'once',
    expected_operation_revision: 2,
    data_folder: 'unused',
    action: 'windows.install-amd-npu',
    recipe_id: recipe.recipe_id,
    recipe_digest: canonicalDigest(recipe),
    parameters,
    parameters_digest: canonicalDigest(parameters),
  }
}
const launchDigest = (input: ReturnType<typeof request>) =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex')
async function run(
  input: ReturnType<typeof request>,
  native: NpuInstallerIo,
  digest: string | null = launchDigest(input)
) {
  const deps = {
    now: () => 1,
    readRequest: async () => JSON.stringify(input),
    writeResult: vi.fn(),
    installWindowsNpu: (id: string) => installWindowsNpu(id, native),
  } as unknown as HostStepExecutorDeps
  return executeHostStep('step-1.request.json', deps, digest ?? undefined)
}
it.each([
  [0, 'completed'],
  [3010, 'reboot-required'],
  [1223, 'declined'],
  [5, 'failed'],
] as const)('handles the device installer result %s', async (code, outcome) => {
  const native = io()
  vi.mocked(native.install).mockResolvedValue(code)
  expect(await run(request(), native)).toMatchObject({
    outcome,
    nonce: 'once',
    recipe_digest: request().recipe_digest,
  })
  expect(native.install).toHaveBeenCalledWith('stage', target)
})
it('rejects substituted bytes or package metadata before applying a driver', async () => {
  const native = io()
  vi.mocked(native.download).mockImplementation(async () => checkNpuCab(Buffer.from('substitution')))
  expect((await run(request(), native)).outcome).toBe('failed')
  expect(native.install).not.toHaveBeenCalled()
  const altered = request()
  altered.parameters.environment_manifest.recipes[0]!.driver.sha256 = '0'.repeat(64)
  altered.parameters.manifest_digest = canonicalDigest(altered.parameters.environment_manifest)
  altered.parameters_digest = canonicalDigest(altered.parameters)
  altered.recipe_digest = canonicalDigest(altered.parameters.environment_manifest.recipes[0])
  expect(await run(altered, native)).toMatchObject({ error_code: 'MANAGED_HOST_STEP_INVALID' })
})
it.each([
  ['unsupported', 'failed'],
  ['satisfied', 'completed'],
] as const)('does no staging for a device which is %s', async (state, outcome) => {
  const native = io()
  vi.mocked(native.state).mockResolvedValue(state)
  expect((await run(request(), native)).outcome).toBe(outcome)
  expect(native.withStage).not.toHaveBeenCalled()
})
it('refuses target substitution and stale digests', async () => {
  for (const modify of [
    (r: ReturnType<typeof request>) => {
      r.parameters.device_instance_id = 'PCI\\VEN_1022&DEV_1502'
    },
    (r) => {
      r.parameters.recipe_revision++
    },
    (r) => {
      r.recipe_digest = canonicalDigest({})
    },
  ] satisfies ((r: ReturnType<typeof request>) => void)[]) {
    const r = request(),
      native = io()
    modify(r)
    expect(await run(r, native)).toMatchObject({ error_code: 'MANAGED_HOST_STEP_INVALID' })
    expect(native.state).not.toHaveBeenCalled()
  }
})
it('stops before driver-store mutation when Windows rejects the catalog or the compatible INF', async () => {
  const native = io()
  vi.mocked(native.verify).mockRejectedValue(Error('Windows rejected the NPU catalog publisher or signature'))
  expect(await run(request(), native)).toMatchObject({
    outcome: 'failed',
    log_tail: expect.stringContaining('publisher'),
  })
  expect(native.install).not.toHaveBeenCalled()
})
it('reports a satisfied step if another installation finished during download', async () => {
  const native = io()
  vi.mocked(native.install).mockResolvedValue('satisfied')
  expect(await run(request(), native)).toMatchObject({
    outcome: 'completed',
    steps: [{ status: 'satisfied' }],
  })
})

it('requires the launch digest and refuses a second valid target even with recomputed file digests', async () => {
  const approved = request(),
    changed = request(),
    native = io()
  changed.parameters.device_instance_id = target.replace('0041', '0021')
  changed.parameters_digest = canonicalDigest(changed.parameters)
  for (const digest of [null, launchDigest(approved)]) {
    expect(await run(changed, native, digest)).toMatchObject({
      error_code: 'MANAGED_HOST_STEP_INVALID',
      steps: [],
    })
  }
  expect(native.state).not.toHaveBeenCalled()
})
