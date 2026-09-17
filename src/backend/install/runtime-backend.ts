/** Resolve the installed backend a runtime may actually execute on this host. */
import { AtomicCoreError } from '../../contracts/index.js'
import type { LocalProviderId } from '../../contracts/index.js'
import type { DataLayout } from '../../config/index.js'
import type { RuntimeSettings } from '../../runtime/llamacpp/index.js'
import { isConcreteVersionBackend } from '../../runtime/llamacpp/index.js'
import { canonicalProviderDefaults } from '../../settings/index.js'
import type { SettingsStore } from '../../settings/index.js'
import type { HardwareOverrideStore } from '../../hardware/index.js'
import { discoverBackendBinary, resolveBackendExe, scanInstalledBackends } from '../installed/index.js'
import {
  determineBestBackend,
  determineSupportedBackends,
  filterBackendsBySupport,
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
  hardware: HardwareOverrideStore
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
  hardware: HardwareOverrideStore,
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

/** Choose among installed packs using the app-injected hardware facts, never directory order. */
export async function selectInstalledBackend(
  layout: DataLayout,
  provider: LocalProviderId,
  hardware: HardwareOverrideStore,
  hostArch = process.arch,
  probeRocm: () => Promise<RocmHostProbe> = probeLinuxRocmHost
) {
  const installed = await scanInstalledBackends(layout, provider)
  if (installed.length === 0) return discoverBackendBinary(layout, provider)
  const override = hardware.get()
  const osType = override?.os_type ?? platformOsType(process.platform)
  const arch = platformArch(hostArch)
  const gpus = hardware.gpus([])
  let selected: string
  if (provider === 'llamacpp') {
    // The fork's own matrix, ids and priorities: the upstream ones filter every TurboQuant pack out.
    const rocm = osType === 'linux' ? await probeRocm() : undefined
    const features = getTurboquantSupportedFeatures(osType, hardware.cpuExtensions([]), gpus, rocm)
    const supported = determineTurboquantSupportedBackends(osType, arch, features)
    const compatible = filterTurboquantBackendsBySupport(installed, supported)
    if (compatible.length === 0) return undefined
    selected = determineBestTurboquantBackend(compatible, gpus)
  } else {
    const features = getSupportedFeatures(osType, hardware.cpuExtensions([]), gpus)
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

function platformOsType(platform: NodeJS.Platform): string {
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'macos'
  return platform
}

function platformArch(arch: string): string {
  if (arch === 'x64') return 'x86_64'
  if (arch === 'ia32') return 'x86'
  return arch
}
