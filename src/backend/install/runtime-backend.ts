/** Resolve the installed backend a runtime may actually execute on this host. */
import { AtomicCoreError } from '../../contracts/index.js'
import type { LocalProviderId } from '../../contracts/index.js'
import type { DataLayout } from '../../config/index.js'
import type { RuntimeSettings } from '../../runtime/llamacpp/index.js'
import { isConcreteVersionBackend } from '../../runtime/llamacpp/index.js'
import { canonicalProviderDefaults } from '../../settings/index.js'
import type { SettingsStore } from '../../settings/index.js'
import { rustArch } from '../../hardware/index.js'
import type { HardwareFactsSource } from '../../hardware/index.js'
import { prismTagBuild } from '../catalog/index.js'
import { discoverBackendBinary, resolveBackendExe, scanInstalledBackends } from '../installed/index.js'
import {
  determineBestBackend,
  determineBestPrismBackend,
  determinePrismSupportedBackends,
  determineSupportedBackends,
  filterBackendsBySupport,
  filterPrismBackendsBySupport,
  getPrismSupportedFeatures,
  getSupportedFeatures,
} from '../select/index.js'
import {
  determineBestTurboquantBackend,
  determineTurboquantSupportedBackends,
  filterTurboquantBackendsBySupport,
  getTurboquantSupportedFeatures,
  probeLinuxRocmHost,
} from '../turboquant.js'
import type { RocmHostProbe } from '../turboquant.js'

/** Provider settings plus the engine-level keys the load plan reads. */
export async function readRuntimeSettings(
  settings: SettingsStore,
  provider: LocalProviderId,
  layout: DataLayout,
  hardware: HardwareFactsSource
): Promise<RuntimeSettings> {
  const values = { ...canonicalProviderDefaults(provider), ...settings.get(provider) }
  const configured = String(values['version_backend'] ?? '').trim()
  if (!isConcreteVersionBackend(configured)) {
    const discovered = await selectInstalledBackend(layout, provider, hardware)
    if (discovered) values['version_backend'] = discovered.version_backend
  }
  return {
    config: values as RuntimeSettings['config'],
    engine: {
      timeout: (values['timeout'] as number | string | undefined) ?? 600,
      llamacpp_env: (values['llamacpp_env'] as string | undefined) ?? '',
      ...(values['dflash_block_size'] !== undefined
        ? { dflash_block_size: values['dflash_block_size'] as number | string }
        : {}),
    },
  }
}

/**
 * The installed backend a load runs on: the configured pack when it is on disk, otherwise the best
 * compatible installed one. `repair` runs on the pack that will be used before it is returned — the
 * TurboQuant provider puts a missing CUDA runtime back there, as its extension did before every load.
 */
export async function ensureBackend(
  layout: DataLayout,
  provider: LocalProviderId,
  backend: string,
  version: string,
  hardware: HardwareFactsSource,
  hostArch = process.arch,
  repair?: (backend: string, version: string) => Promise<void>
): Promise<{ version: string; backend: string; exePath: string }> {
  const exact = await resolveBackendExe(layout, provider, version, backend)
  if (exact) {
    await repair?.(backend, version)
    return { version, backend, exePath: exact }
  }
  const discovered = await selectInstalledBackend(layout, provider, hardware, hostArch)
  if (discovered) {
    await repair?.(discovered.backend, discovered.version)
    return { version: discovered.version, backend: discovered.backend, exePath: discovered.path }
  }
  throw new AtomicCoreError(
    'BINARY_NOT_FOUND',
    'No llama.cpp backend is installed in this data folder.',
    `looked for ${version}/${backend} under ${layout.provider(provider).backendsDir}`
  )
}

/** Choose among installed packs using the hardware facts (probe or override), never directory order. */
export async function selectInstalledBackend(
  layout: DataLayout,
  provider: LocalProviderId,
  hardware: HardwareFactsSource,
  hostArch = process.arch,
  probeRocm: () => Promise<RocmHostProbe> = probeLinuxRocmHost
) {
  const installed = await scanInstalledBackends(layout, provider)
  if (installed.length === 0) return discoverBackendBinary(layout, provider)
  const facts = await hardware.facts()
  const osType = facts.osType
  const arch = platformArch(hostArch)
  const gpus = facts.gpus
  // Unknown flags read as none here: the feature gates only add tiers for flags that are present.
  const cpuExtensions = facts.cpuExtensions ?? []
  let selected: string
  if (provider === 'llamacpp') {
    // The fork's own matrix, ids and priorities: the upstream ones filter every TurboQuant pack out.
    const rocm = osType === 'linux' ? await probeRocm() : undefined
    const features = getTurboquantSupportedFeatures(osType, cpuExtensions, gpus, rocm)
    const supported = determineTurboquantSupportedBackends(osType, arch, features)
    const compatible = filterTurboquantBackendsBySupport(installed, supported)
    if (compatible.length === 0) return undefined
    selected = determineBestTurboquantBackend(compatible, gpus)
  } else if (provider === 'atomic-prism') {
    const rocm = osType === 'linux' ? await probeRocm() : undefined
    const features = getPrismSupportedFeatures(osType, cpuExtensions, gpus, rocm)
    // A pack under another release train's tag was not installed from the Prism manifest.
    const prismPacks = installed.filter((pack) => prismTagBuild(pack.version) !== null)
    const compatible = filterPrismBackendsBySupport(
      prismPacks,
      determinePrismSupportedBackends(osType, arch, features)
    )
    if (compatible.length === 0) return undefined
    selected = determineBestPrismBackend(compatible, gpus)
  } else {
    const features = getSupportedFeatures(osType, cpuExtensions, gpus)
    const supported = determineSupportedBackends(osType, arch, features)
    const compatible = filterBackendsBySupport(installed, supported, osType)
    if (compatible.length === 0) return undefined
    selected = determineBestBackend(compatible, gpus)
  }
  const [version, backend] = selected.split('/')
  if (!version || !backend) return undefined
  const path = await resolveBackendExe(layout, provider, version, backend)
  return path ? { path, version_backend: selected, version, backend } : undefined
}

/** Node's `process.arch` in the Rust spelling the backend and CPU policies expect; the rule is `hardware/facts.ts`'s `rustArch`. */
export function platformArch(arch: string): string {
  return rustArch(arch)
}
