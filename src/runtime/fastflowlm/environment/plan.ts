import {
  AtomicCoreError,
  type FastFlowLmAccelerators,
  type FastFlowLmProbePlan,
  type FastFlowLmNpu,
} from '../../../contracts/index.js'
import { supportedLinuxNpuRecipe, matchesNpuFirmware } from './linux-policy.js'
import { supportedWindowsDriver } from './windows-driver.js'
import { CORE_VERSION } from '../../../version.js'
import { canonicalDigest } from '../../environment/index.js'
import type { FlmManifest, FlmRecipe } from './manifest.js'

export interface PreparationHost {
  os: string
  arch: string
  distribution: string | null
  version: string | null
  kernel_release: string | null
  mutable: boolean | null
}
type Actions = Pick<FastFlowLmProbePlan, 'packages' | 'changes'>
function compare(a: string, b: string) {
  const left = a.split('.'),
    right = b.split('.')
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = BigInt(left[i] ?? 0),
      y = BigInt(right[i] ?? 0)
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}
function actions(recipe: FlmRecipe, facts: FastFlowLmAccelerators, target: FastFlowLmNpu): Actions | null {
  const pending = new Set(facts.blockers)
  const changes: Actions['changes'] = [],
    packages: Actions['packages'] = []
  pending.delete('engine-not-installed')
  if (recipe.action === 'windows.install-amd-npu') {
    const d = recipe.driver
    if (!supportedWindowsDriver(d)) return null
    if (!/^\d+(\.\d+){3}$/.test(facts.required.driver) || compare(d.version, facts.required.driver) < 0)
      return null
    if (!(pending.delete('driver-missing') && target.driver === 'missing')) {
      const old = target.driver_version
      if (!pending.delete('driver-version-unconfirmed') || !old || compare(old, facts.required.driver) >= 0)
        return null
      pending.delete('native-validation-failed')
      pending.delete('xrt-device-unavailable')
    }
    packages.push({ name: d.kind, version: d.version, source: d.url, sha256: d.sha256 })
    changes.push({
      code: 'install-driver',
      text: 'Install the signed driver for the selected AMD NPU.',
      params: { device: target.id, signer: d.signer, version: d.version },
    })
  } else {
    const missing = pending.delete('driver-missing') && target.driver === 'missing'
    const oldDriver =
      pending.has('driver-version-unconfirmed') &&
      target.driver_version &&
      compare(target.driver_version, '0.6') < 0
    const oldFirmware =
      pending.has('firmware-unconfirmed') &&
      target.firmware &&
      compare(target.firmware, '1.1') < 0 &&
      compare(recipe.firmware_version, '1.1') >= 0
    if (oldDriver) pending.delete('driver-version-unconfirmed')
    if (oldFirmware) pending.delete('firmware-unconfirmed')
    const denied = pending.delete('device-access-denied') && target.accessible === false
    // Opening XRT maps locked buffers. A low owner limit can make a healthy device report open=false.
    // Correct a confirmed limit first, then probe again before considering an XRT package.
    const limit = pending.delete('memlock-too-low')
    const recheckXrt =
      limit && target.driver === 'bound' && target.accessible === true && target.xrt_visible === false
    if (recheckXrt) pending.delete('xrt-device-unavailable')
    const xrt = pending.has('xrt-device-unavailable') && recipe.xrt === 'system'
    if (missing || oldDriver || oldFirmware || xrt) {
      const names = recipe.packages.map((p) => p.name)
      if ((missing || oldDriver || oldFirmware) && !names.includes('amdxdna-dkms')) return null
      const xrtPackages = ['libxrt-npu2', 'libxrt2', 'libxrt-utils', 'libxrt-utils-npu']
      const pinned =
        missing || oldDriver || oldFirmware
          ? recipe.packages.filter((p) => recipe.xrt === 'system' || !xrtPackages.includes(p.name))
          : recipe.packages.filter((p) => xrtPackages.includes(p.name))
      for (const p of pinned) {
        const s = recipe.sources.find((s) => s.id === p.source)!
        packages.push({ name: p.name, version: p.version, sha256: p.sha256, source: s.url + p.path })
      }
      for (const s of recipe.sources.filter((s) => pinned.some((p) => p.source === s.id)))
        changes.push({
          code: 'package-source',
          text: 'Verify the signed package source.',
          params: { url: s.url, suite: s.suite, component: s.component, fingerprint: s.signing_fingerprint },
        })
      changes.push({
        code: 'install-packages',
        text: 'Install the pinned AMD NPU dependencies for the running kernel.',
      })
    }
    if (denied)
      changes.push({
        code: 'device-access',
        text: 'Grant the runtime account access to this AMD NPU.',
        params: { account: facts.runtime_account!, device: target.pci_device_id },
      })
    if (xrt || denied || oldDriver || oldFirmware) pending.delete('xrt-device-unavailable')
    if (limit) {
      if (
        !facts.required.memlock_bytes ||
        BigInt(recipe.memlock_bytes) < BigInt(facts.required.memlock_bytes)
      )
        return null
      const code =
        facts.runtime_mode === 'system-service'
          ? 'service-memlock'
          : facts.runtime_mode === 'user-service'
            ? 'user-service-memlock'
            : 'account-memlock'
      changes.push({
        code,
        text:
          code === 'user-service-memlock'
            ? 'Check the user manager limit and set the service locked-memory limit.'
            : 'Set the locked-memory limit for this runtime identity.',
        params: {
          account: facts.runtime_account!,
          bytes: String(recipe.memlock_bytes),
          ...(facts.runtime_service ? { unit: facts.runtime_service } : {}),
        },
      })
      pending.delete('native-memlock-unconfirmed')
    }
    if (
      packages.some((p) => p.name === 'amdxdna-dkms') &&
      !matchesNpuFirmware(target.pci_revision, recipe.firmware_version)
    )
      return null
    if (oldDriver || oldFirmware || limit) pending.delete('native-validation-failed')
    if (
      !supportedLinuxNpuRecipe(
        recipe,
        packages.map((p) => p.name)
      )
    )
      return null
  }
  return changes.length && !pending.size ? { packages, changes } : null
}
export function preparationPlan(
  facts: FastFlowLmAccelerators,
  host: PreparationHost,
  manifest: FlmManifest | null,
  build = facts.engine_version
): FastFlowLmProbePlan {
  let recipe: FlmRecipe | null = null
  let work: Actions | null = null
  const targets = facts.devices.filter((d) => d.generation === 'xdna2')
  const target = targets[0]
  const blockers = [...facts.blockers]
  const identityKnown =
    facts.runtime_account &&
    facts.runtime_mode &&
    facts.runtime_mode.endsWith('-service') === Boolean(facts.runtime_service)
  if (!facts.ready && !identityKnown) blockers.push('runtime-identity-unknown')
  const reliable = !facts.blockers.some((b) =>
    ['device-busy', 'privileged-account', 'account-unknown', 'probe-inconclusive'].includes(b)
  )
  if (!facts.ready && identityKnown && target && targets.length === 1 && reliable) {
    if (
      host.arch !== 'x64' ||
      (host.os === 'windows'
        ? host.version !== '11'
        : host.os !== 'linux' ||
          host.distribution !== 'ubuntu' ||
          !['24.04', '26.04'].includes(host.version ?? ''))
    )
      blockers.push('platform-not-qualified')
    else if (host.os === 'linux' && host.mutable !== true) blockers.push('mutable-host-unconfirmed')
    else if (!manifest) blockers.push('manifest-unavailable')
    else if (manifest.platform === host.os) {
      recipe =
        manifest.recipes.find(
          (r) =>
            r.qualification.build_version === build &&
            compare(r.min_core_version, CORE_VERSION) <= 0 &&
            r.hardware.pci_device_ids.includes(target.pci_device_id) &&
            r.platforms.some(
              (p) =>
                p.os === host.os &&
                p.arch === host.arch &&
                p.version === host.version &&
                (!('kernel_release' in p) || p.kernel_release === host.kernel_release)
            )
        ) ?? null
      if (recipe) work = actions(recipe, facts, target)
      else blockers.push('no-qualified-recipe')
    }
  }
  const result = {
    status: facts.ready ? ('ready' as const) : work ? ('action-required' as const) : ('blocked' as const),
    runtime_account: facts.runtime_account,
    runtime_mode: facts.runtime_mode,
    runtime_service: facts.runtime_service,
    engine_version: build,
    manifest_id: manifest?.manifest_id ?? null,
    manifest_digest: manifest ? canonicalDigest(manifest) : null,
    recipe_id: recipe?.recipe_id ?? null,
    recipe_revision: recipe?.revision ?? null,
    recipe_digest: recipe ? canonicalDigest(recipe) : null,
    packages: work?.packages ?? [],
    changes: work?.changes ?? [],
    blockers: [...new Set(blockers)],
  }
  return {
    ...result,
    plan_digest: canonicalDigest({
      result,
      host,
      devices: facts.devices,
      limits: facts.memlock_bytes,
      required: facts.required,
      detected: facts.blockers,
    }),
  }
}
export function assertCurrentPlan(plan: FastFlowLmProbePlan, approvedDigest: string) {
  if (plan.status !== 'action-required' || plan.plan_digest !== approvedDigest)
    throw new AtomicCoreError(
      'MANAGED_PLAN_CHANGED',
      'The FastFlowLM preparation plan must be approved again.'
    )
}
