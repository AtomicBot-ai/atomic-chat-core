import { expect, it } from 'vitest'
import { kernel, linuxManifest, windowsManifest, flmFacts } from '../../../../test/helpers/flm-environment.js'
import { parseEnvironment } from './manifest.js'
import { preparationPlan, assertCurrentPlan } from './plan.js'

const host = {
  os: 'linux',
  distribution: 'ubuntu',
  version: '24.04',
  arch: 'x64',
  kernel_release: kernel,
  mutable: true,
}
const manifest = () => parseEnvironment(linuxManifest(), 'linux')
it('accepts a ready host offline and explains an unavailable or unqualified recipe', () => {
  expect(preparationPlan(flmFacts([]), host, null)).toMatchObject({
    status: 'ready',
    packages: [],
    changes: [],
    blockers: [],
    manifest_digest: null,
  })
  expect(preparationPlan(flmFacts(), host, null).blockers).toContain('manifest-unavailable')
  for (const override of [
    { distribution: 'arch' },
    { kernel_release: '6.18.0' },
    { mutable: false },
    { arch: 'arm64' },
  ])
    expect(preparationPlan(flmFacts(), { ...host, ...override }, manifest())).toMatchObject({
      status: 'blocked',
      changes: [],
      packages: [],
      recipe_digest: null,
    })
})
it('binds consent to the account, unit, device and pinned dependency versions', () => {
  const current = preparationPlan(flmFacts(), host, manifest())
  expect(current).toMatchObject({
    status: 'action-required',
    recipe_revision: 1,
    packages: [
      {
        version: '7.0.0-rc1+git20260310.6b13cb8f4-noble1',
        source: expect.stringMatching(/^https:\/\/ppa\./),
      },
    ],
  })
  expect(() => assertCurrentPlan(current, current.plan_digest)).not.toThrow()
  for (const facts of [
    { ...flmFacts(), runtime_account: 'other' },
    { ...flmFacts(), runtime_service: 'new.service' },
  ])
    expect(() => assertCurrentPlan(preparationPlan(facts, host, manifest()), current.plan_digest)).toThrow()
  expect(preparationPlan({ ...flmFacts(), engine_version: 'flm-1.0.11-r3' }, host, manifest()).status).toBe(
    'blocked'
  )
})
it('shows only the account-scoped change for a memlock-only failure', () => {
  const facts = { ...flmFacts(['memlock-too-low']), memlock_bytes: '8388608' }
  const plan = preparationPlan(facts, host, manifest())
  expect(plan.packages).toEqual([])
  expect(plan.changes).toEqual([
    {
      code: 'service-memlock',
      text: expect.any(String),
      params: expect.objectContaining({ account: 'atomic', unit: 'atc.service', bytes: '2147483648' }),
    },
  ])
  expect(preparationPlan({ ...facts, runtime_mode: null }, host, manifest()).status).toBe('blocked')
})
it('only targets the matched Windows device and driver package', () => {
  const plan = preparationPlan(
    { ...flmFacts(), required: { ...flmFacts().required, driver: '32.0.203.304' } },
    { ...host, os: 'windows', version: '11' },
    parseEnvironment(windowsManifest(), 'windows')
  )
  expect(plan).toMatchObject({
    status: 'action-required',
    packages: [{ version: '32.0.203.314' }],
    changes: [{ code: 'install-driver' }],
  })
})
it('invalidates consent after a dependency revision or target device changes', () => {
  const facts = flmFacts(),
    first = preparationPlan(facts, host, manifest())
  const doc = linuxManifest()
  doc.manifest_id = 'fastflowlm-linux-r2'
  doc.recipes[0]!.revision++
  doc.recipes[0]!.packages[0]!.version = '2.0-test2'
  const next = preparationPlan(facts, host, parseEnvironment(doc, 'linux'))
  expect(next.blockers).toContain('driver-missing')
  expect(() => assertCurrentPlan(next, first.plan_digest)).toThrow()
  expect(() =>
    assertCurrentPlan(
      preparationPlan(
        { ...facts, devices: [{ ...facts.devices[0]!, id: '0000:a3:00.1', bdf: '0000:a3:00.1' }] },
        host,
        manifest()
      ),
      first.plan_digest
    )
  ).toThrow()
})
it.each(['bundled', 'system'])(
  'rechecks %s XRT after correcting a measured low memlock before offering packages',
  (xrt) => {
    const doc = linuxManifest(),
      recipe = doc.recipes[0]!
    recipe.qualification.build_version = 'flm-2.0.0-r1'
    recipe.qualification.evidence.url = recipe.qualification.evidence.url.replace(
      'flm-1.0.11-r2',
      'flm-2.0.0-r1'
    )
    recipe.xrt = xrt
    if (xrt === 'system') recipe.packages.push({ ...recipe.packages[0]!, name: 'libxrt-npu2' })
    const facts = flmFacts([
      'memlock-too-low',
      'native-memlock-unconfirmed',
      'native-validation-failed',
      'xrt-device-unavailable',
    ])
    facts.engine_version = recipe.qualification.build_version
    facts.memlock_bytes = '8388608'
    facts.devices[0]!.xrt_visible = false
    facts.devices[0]!.accessible = true
    const plan = preparationPlan(facts, host, parseEnvironment(doc, 'linux'))
    expect(plan).toMatchObject({
      status: 'action-required',
      packages: [],
      changes: [{ code: 'service-memlock' }],
    })
  }
)

it('fixes owner memlock before rechecking bundled XRT even above the native 100 MiB minimum', () => {
  const facts = flmFacts(['memlock-too-low', 'xrt-device-unavailable'])
  facts.memlock_bytes = String(256 * 1024 ** 2)
  facts.devices[0]!.accessible = true
  facts.devices[0]!.xrt_visible = false
  expect(preparationPlan(facts, host, manifest())).toMatchObject({
    status: 'action-required',
    packages: [],
    changes: [{ code: 'service-memlock' }],
  })
})
it('proposes only account device access when native checks cannot open the node', () => {
  const facts = flmFacts(['device-access-denied'])
  Object.assign(facts.devices[0]!, {
    accessible: false,
    driver_version: null,
    firmware: null,
    xrt_visible: null,
  })
  expect(preparationPlan(facts, host, manifest())).toMatchObject({
    status: 'action-required',
    packages: [],
    changes: [{ code: 'device-access' }],
  })
})
it('limits an XRT-only repair to the qualified userspace packages and sources', () => {
  const doc = linuxManifest(),
    r = doc.recipes[0]!
  r.xrt = 'system'
  r.qualification.build_version = 'flm-2.0.0-r1'
  r.qualification.evidence.url = r.qualification.evidence.url.replace('flm-1.0.11-r2', 'flm-2.0.0-r1')
  r.sources.push({ ...r.sources[0]!, id: 'xrt' })
  r.packages.push(
    { ...r.packages[0]!, name: 'linux-headers-' + kernel },
    ...['libxrt-npu2', 'libxrt2'].map((name) => ({ ...r.packages[0]!, name, source: 'xrt' }))
  )
  const facts = flmFacts(['xrt-device-unavailable'])
  facts.engine_version = r.qualification.build_version
  facts.devices[0]!.accessible = true
  facts.devices[0]!.xrt_visible = false
  const plan = preparationPlan(facts, host, parseEnvironment(doc, 'linux'))
  expect(plan.packages.map((p) => p.name)).toEqual(['libxrt-npu2', 'libxrt2'])
  expect(plan.changes.filter((c) => c.code === 'package-source').map((c) => c.params?.url)).toEqual([
    'https://ppa.launchpadcontent.net/lemonade-team/stable/ubuntu/',
  ])
})
it('withholds automatic Windows repair for a package this helper cannot apply', () => {
  const doc = windowsManifest()
  doc.recipes[0]!.driver.sha256 = 'c'.repeat(64)
  const facts = flmFacts()
  facts.required.driver = '32.0.203.304'
  expect(
    preparationPlan(facts, { ...host, os: 'windows', version: '11' }, parseEnvironment(doc, 'windows'))
  ).toMatchObject({ status: 'blocked', packages: [], changes: [] })
})

it('withholds driver repair for an incompatible or unknown PCI revision before consent', () => {
  const facts = flmFacts()
  for (const revision of ['11', undefined]) {
    if (revision) facts.devices[0]!.pci_revision = revision
    else delete facts.devices[0]!.pci_revision
    expect(preparationPlan(facts, host, manifest())).toMatchObject({
      status: 'blocked',
      packages: [],
      changes: [],
    })
  }
  facts.devices[0]!.pci_revision = '11'
  const doc = linuxManifest()
  doc.recipes[0]!.firmware_version = '1.1.2.65'
  expect(preparationPlan(facts, host, parseEnvironment(doc, 'linux')).status).toBe('action-required')
})
