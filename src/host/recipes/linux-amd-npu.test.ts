import { createHash } from 'node:crypto'
import { executeHostStep, type HostStepExecutorDeps } from './executor.js'
import { expect, it, vi } from 'vitest'
import { linuxNpuTarget, firmwareLink, verifyAptRecord, checkAptSimulation } from './linux-amd-npu.js'
import { linuxManifest, kernel } from '../../../test/helpers/flm-environment.js'
import { canonicalDigest } from '../../runtime/environment/index.js'
import type { HostStepRequest } from './request-file.js'

const fingerprint = '881CF4B40B0BFA288D6776E83BF36CFA0BD50AEC'
function fixture(version = '24.04') {
  const m = linuxManifest(),
    recipe = m.recipes[0]!
  recipe.platforms[0]!.version = version
  if (version === '26.04')
    Object.assign(recipe.packages[0]!, {
      path: 'pool/main/a/amdxdna-dkms/amdxdna-dkms_7.0.0-rc1+git20260310.6b13cb8f4-resolute1_amd64.deb',
      sha256: '53b8c345bb00c8253a2e13a120bff16fcd7346bc669cf65813dfac7613325a25',
      version: '7.0.0-rc1+git20260310.6b13cb8f4-resolute1',
      size: 315378,
    })
  Object.assign(recipe.sources[0]!, {
    signing_fingerprint: fingerprint,
    suite: version === '24.04' ? 'noble' : 'resolute',
  })
  const parameters = {
    manifest_id: m.manifest_id,
    manifest_digest: canonicalDigest(m),
    recipe_revision: 1,
    environment_manifest: m,
    device_instance_id: '0000:c4:00.1',
    runtime_account: 'lex',
    runtime_mode: 'interactive',
    runtime_service: null,
    package_names: ['amdxdna-dkms'],
    device_access: false,
    memlock: true,
  }
  const request = {
    parameters,
    parameters_digest: canonicalDigest(parameters),
    recipe_id: recipe.recipe_id,
    recipe_digest: canonicalDigest(recipe),
  } as unknown as HostStepRequest
  return { request, recipe, parameters }
}
it.each(['24.04', '26.04'])('binds the requested Ubuntu %s recipe to an exact kernel and account', (v) => {
  const target = linuxNpuTarget(fixture(v).request)
  expect(target?.recipe.platforms[0]).toMatchObject({ version: v, kernel_release: kernel })
  expect(target?.account).toBe('lex')
})
it('rejects a different signing identity, a system kernel package or a wildcard user', () => {
  for (const edit of [
    (f: ReturnType<typeof fixture>) => {
      f.recipe.sources[0]!.signing_fingerprint = 'A'.repeat(40)
    },
    (f: ReturnType<typeof fixture>) => {
      f.recipe.packages[0]!.name = 'linux-image-generic'
      f.parameters.package_names = ['linux-image-generic']
    },
    (f: ReturnType<typeof fixture>) => {
      f.parameters.runtime_account = '*'
    },
  ]) {
    const f = fixture()
    edit(f)
    f.parameters.manifest_digest = canonicalDigest(f.parameters.environment_manifest)
    f.request.parameters_digest = canonicalDigest(f.parameters)
    f.request.recipe_digest = canonicalDigest(f.recipe)
    expect(linuxNpuTarget(f.request)).toBeNull()
  }
})
it('refuses missing versions, wrong digests and a dependency transaction outside the pins', () => {
  const p = { ...fixture().recipe.packages[0]!, architecture: 'amd64' as const }
  const record = `Package: ${p.name}\nVersion: ${p.version}\nArchitecture: amd64\nFilename: ${p.path}\nSize: ${p.size}\nSHA256: ${p.sha256}`
  expect(() => verifyAptRecord(record, p)).not.toThrow()
  for (const bad of ['', record.replace(p.version, '2'), record.replace(p.sha256, 'b'.repeat(64))])
    expect(() => verifyAptRecord(bad, p)).toThrow()
  expect(() => checkAptSimulation('Inst linux-image-generic (1 Ubuntu [amd64])', [p])).toThrow()
  expect(() => checkAptSimulation('Remv unused [1]', [p])).toThrow()
})
it('requires the target firmware link to select the recipe version', () => {
  const listing =
    'lrwxrwxrwx root/root 0 date ./lib/firmware/updates/amdnpu/17f0_10/npu_7.sbin -> npu.sbin.1.1.2.64\n-rw-r--r-- root/root 100 date ./lib/firmware/updates/amdnpu/17f0_10/npu.sbin.1.1.2.64'
  expect(firmwareLink(listing, '10', '1.1.2.64')).toBe(true)
  expect(firmwareLink(listing, '20', '1.1.2.64')).toBe(true)
  expect(firmwareLink(listing, '11', '1.1.2.64')).toBe(false)
  expect(firmwareLink(listing, '10', '1.1.2.65')).toBe(false)
})

it('dispatches a Linux request only with its pre-elevation digest and records the outcome', async () => {
  const r = {
    ...fixture().request,
    action: 'linux.install-amd-npu',
    schema_version: 1,
    step_id: 'npu',
    operation_id: 'op',
    nonce: 'once',
    expected_operation_revision: 1,
    data_folder: '/data',
  }
  const text = JSON.stringify(r),
    digest = createHash('sha256').update(text).digest('hex')
  const installLinuxNpu = vi.fn(async () => 'relogin-required')
  const deps = {
    installLinuxNpu,
    readRequest: async () => text,
    writeResult: vi.fn(),
    now: () => 1,
  } as unknown as HostStepExecutorDeps
  expect((await executeHostStep('npu.request.json', deps)).error_code).toBe('MANAGED_HOST_STEP_INVALID')
  expect((await executeHostStep('npu.request.json', deps, digest)).outcome).toBe('relogin-required')
  installLinuxNpu.mockRejectedValue(Error('APT signature invalid'))
  expect(await executeHostStep('npu.request.json', deps, digest)).toMatchObject({
    outcome: 'failed',
    log_tail: 'APT signature invalid',
  })
  expect(installLinuxNpu).toHaveBeenCalledTimes(2)
  delete deps.installLinuxNpu
  expect((await executeHostStep('npu.request.json', deps, digest)).error_code).toBe(
    'MANAGED_HOST_STEP_INVALID'
  )
})

it.each(['system-service', 'user-service'])(
  'asks to restart the named %s and records its scope',
  async (mode) => {
    const f = fixture(),
      p = { ...f.parameters, runtime_mode: mode, runtime_service: 'atc.service' }
    const text = JSON.stringify({
      ...f.request,
      parameters: p,
      parameters_digest: canonicalDigest(p),
      action: 'linux.install-amd-npu',
      schema_version: 1,
      operation_id: 'op',
      step_id: 'npu',
      nonce: 'once',
      expected_operation_revision: 1,
      data_folder: '/data',
    })
    const deps = {
      readRequest: async () => text,
      writeResult: vi.fn(),
      now: () => 1,
      installLinuxNpu: async () => 'service-restart-required',
    } as unknown as HostStepExecutorDeps
    expect(
      await executeHostStep('npu.request.json', deps, createHash('sha256').update(text).digest('hex'))
    ).toMatchObject({
      outcome: 'service-restart-required',
      activation: { kind: 'restart-service', account: 'lex', unit: 'atc.service', scope: mode.split('-')[0] },
      log_tail: expect.stringContaining('atc.service'),
    })
  }
)
