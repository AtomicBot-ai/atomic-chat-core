/** Resolve the installed backend a runtime may actually execute on this host. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import type { LocalProviderId } from '../../contracts/index.js'
import type { DataLayout } from '../../config/index.js'
import type { RuntimeSettings } from '../../runtime/llamacpp/index.js'
import { isConcreteVersionBackend } from '../../runtime/llamacpp/index.js'
import { canonicalProviderDefaults } from '../../settings/index.js'
import type { SettingsStore } from '../../settings/index.js'
import { rustArch } from '../../hardware/index.js'
import type { HardwareFacts, HardwareFactsSource } from '../../hardware/index.js'
import { prismTagBuild } from '../catalog/index.js'
import { discoverBackendBinary, resolveBackendExe, scanInstalledBackends } from '../installed/index.js'
import {
  BAD_BACKENDS_FILE,
  determineBestBackend,
  determineBestPrismBackend,
  determinePrismSupportedBackends,
  determineSupportedBackends,
  filterBackendsBySupport,
  filterPrismBackendsBySupport,
  getPrismSupportedFeatures,
  getSupportedFeatures,
  gpuDriverKey,
  isBackendMarkedBad,
  nextFallbackBackend,
  parseBadBackends,
  serializeBadBackends,
  withBadBackend,
} from '../select/index.js'
import type { BadBackendEntry } from '../select/index.js'
import {
  determineBestTurboquantBackend,
  determineTurboquantSupportedBackends,
  filterTurboquantBackendsBySupport,
  getTurboquantSupportedFeatures,
  probeLinuxRocmHost,
} from '../turboquant.js'
import type { RocmHostProbe } from '../turboquant.js'
import type { BackendVersion } from '../types.js'

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
 * The installed backend a load runs on: the configured pack when it is on disk and has not failed on
 * this machine, otherwise the best compatible installed one; a pack that failed here is still used
 * when nothing else is installed. `repair` runs on the pack that will be used before it is returned —
 * the TurboQuant provider puts a missing CUDA runtime back there, as its extension did before every
 * load.
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
  const skipExact =
    exact !== undefined && (await badBackendFilter(layout, provider, hardware))(backend, version)
  if (exact && !skipExact) {
    await repair?.(backend, version)
    return { version, backend, exePath: exact }
  }
  const discovered = await selectInstalledBackend(layout, provider, hardware, hostArch)
  if (discovered && !(exact && discovered.path === exact)) {
    await repair?.(discovered.backend, discovered.version)
    return { version: discovered.version, backend: discovered.backend, exePath: discovered.path }
  }
  if (exact) {
    await repair?.(backend, version)
    return { version, backend, exePath: exact }
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
  const { compatible, gpus } = await compatibleBackends(installed, provider, hardware, hostArch, probeRocm)
  // A pack that failed on this machine is passed over while another compatible one is installed.
  const isBad = await badBackendFilter(layout, provider, hardware)
  const usable = compatible.filter((pack) => !isBad(pack.backend, pack.version))
  const pool = usable.length > 0 ? usable : compatible
  if (pool.length === 0) return undefined
  const selected =
    provider === 'llamacpp'
      ? determineBestTurboquantBackend(pool, gpus)
      : provider === 'atomic-prism'
        ? determineBestPrismBackend(pool, gpus)
        : determineBestBackend(pool, gpus)
  const [version, backend] = selected.split('/')
  if (!version || !backend) return undefined
  const path = await resolveBackendExe(layout, provider, version, backend)
  return path ? { path, version_backend: selected, version, backend } : undefined
}

/** The installed packs this host's hardware may run, by the provider's own matrix and ids. */
async function compatibleBackends(
  installed: readonly BackendVersion[],
  provider: LocalProviderId,
  hardware: HardwareFactsSource,
  hostArch: string,
  probeRocm: () => Promise<RocmHostProbe>
): Promise<{ compatible: BackendVersion[]; gpus: HardwareFacts['gpus'] }> {
  const facts = await hardware.facts()
  const osType = facts.osType
  const arch = platformArch(hostArch)
  const gpus = facts.gpus
  // Unknown flags read as none here: the feature gates only add tiers for flags that are present.
  const cpuExtensions = facts.cpuExtensions ?? []
  if (provider === 'llamacpp') {
    // The fork's own matrix, ids and priorities: the upstream ones filter every TurboQuant pack out.
    const rocm = osType === 'linux' ? await probeRocm() : undefined
    const features = getTurboquantSupportedFeatures(osType, cpuExtensions, gpus, rocm)
    const supported = determineTurboquantSupportedBackends(osType, arch, features)
    return { compatible: filterTurboquantBackendsBySupport(installed, supported), gpus }
  }
  if (provider === 'atomic-prism') {
    const rocm = osType === 'linux' ? await probeRocm() : undefined
    const features = getPrismSupportedFeatures(osType, cpuExtensions, gpus, rocm)
    // A pack under another release train's tag was not installed from the Prism manifest.
    const prismPacks = installed.filter((pack) => prismTagBuild(pack.version) !== null)
    const supported = determinePrismSupportedBackends(osType, arch, features)
    return { compatible: filterPrismBackendsBySupport(prismPacks, supported), gpus }
  }
  const features = getSupportedFeatures(osType, cpuExtensions, gpus)
  const supported = determineSupportedBackends(osType, arch, features)
  return { compatible: filterBackendsBySupport(installed, supported, osType), gpus }
}

/** `<data>/atomic-core/bad-backends.json`: the llama.cpp packs that could not run on this machine. */
export function badBackendsPath(layout: DataLayout): string {
  return join(layout.core.dir, BAD_BACKENDS_FILE)
}

/** The records on disk; a missing or unreadable file is none. */
export async function readBadBackends(layout: DataLayout): Promise<BadBackendEntry[]> {
  const text = await readFile(badBackendsPath(layout), 'utf8').catch(() => '')
  if (!text.trim()) return []
  try {
    return parseBadBackends(JSON.parse(text))
  } catch {
    return []
  }
}

/** Add or replace one record, written whole through a temporary file so a crash leaves the old one. */
export async function rememberBadBackend(layout: DataLayout, entry: BadBackendEntry): Promise<void> {
  const path = badBackendsPath(layout)
  const next = withBadBackend(await readBadBackends(layout), entry)
  const temporary = `${path}.tmp-${randomUUID()}`
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(temporary, serializeBadBackends(next), 'utf8')
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Whether a backend of `provider` failed on this machine with its current GPU driver. The hardware is
 * asked only when the file names a pack of this provider at all.
 */
async function badBackendFilter(
  layout: DataLayout,
  provider: LocalProviderId,
  hardware: HardwareFactsSource
): Promise<(backend: string, version: string) => boolean> {
  const entries = (await readBadBackends(layout)).filter((e) => e.provider === provider)
  if (entries.length === 0) return () => false
  const driver = gpuDriverKey((await hardware.facts()).gpus)
  return (backend, version) => isBackendMarkedBad(entries, provider, backend, driver, version)
}

/**
 * The runtime's one-shot fallback (`LlamacppRuntimeOptions.backendFallback`): remember that `failed`
 * could not run on this machine (`reason`, keyed by its GPU driver), then answer the next installed
 * compatible pack down the fallback order — CUDA 13 → CUDA 12 → Vulkan → CPU — or nothing. A record
 * that cannot be written does not stop the fallback; it is reported through `log`.
 */
export async function llamaBackendFallback(
  layout: DataLayout,
  provider: LocalProviderId,
  hardware: HardwareFactsSource,
  failed: { version: string; backend: string },
  reason: string,
  options: {
    hostArch?: string
    probeRocm?: () => Promise<RocmHostProbe>
    now?: () => Date
    log?: (message: string) => void
  } = {}
): Promise<{ version: string; backend: string } | undefined> {
  const driver = gpuDriverKey((await hardware.facts()).gpus)
  await rememberBadBackend(layout, {
    provider,
    backend: failed.backend,
    driver,
    reason,
    version: failed.version,
    at: (options.now ?? (() => new Date()))().toISOString(),
  }).catch((error: unknown) =>
    options.log?.(`could not remember ${failed.version}/${failed.backend} as unusable here: ${String(error)}`)
  )
  const installed = await scanInstalledBackends(layout, provider)
  const { compatible } = await compatibleBackends(
    installed,
    provider,
    hardware,
    options.hostArch ?? process.arch,
    options.probeRocm ?? probeLinuxRocmHost
  )
  const isBad = await badBackendFilter(layout, provider, hardware)
  const next = nextFallbackBackend(failed, compatible, isBad)
  return next ? { version: next.version, backend: next.backend } : undefined
}

/** Node's `process.arch` in the Rust spelling the backend and CPU policies expect; the rule is `hardware/facts.ts`'s `rustArch`. */
export function platformArch(arch: string): string {
  return rustArch(arch)
}
