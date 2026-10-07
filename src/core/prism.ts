/**
 * Composition of the PrismML compatibility check for `create.ts`: which Prism build a load would
 * run on (the configured pack when it is on disk, otherwise the best installed one, as the runtime
 * itself chooses), what that release declares it runs, and the `ModelCompatibilityService` that
 * the control routes and every llama.cpp runtime's load gate share.
 */
import type { DataLayout } from '../config/index.js'
import {
  findPrismRelease,
  prismTagBuild,
  resolveBackendExe,
  selectInstalledBackend,
} from '../backend/index.js'
import type { PrismCatalogService } from '../backend/index.js'
import type { HardwareFactsSource } from '../hardware/index.js'
import { hfToken, ModelCompatibilityService, PrismModelRulesService } from '../models/index.js'
import type { InstalledPrism } from '../models/index.js'
import { isConcreteVersionBackend, parseVersionBackend } from '../runtime/llamacpp/index.js'
import type { SettingsStore } from '../settings/index.js'

export interface PrismWiringDeps {
  layout: DataLayout
  settings: Pick<SettingsStore, 'get'>
  hardware: HardwareFactsSource
  prismCatalog: Pick<PrismCatalogService, 'catalog' | 'cachedManifest'>
  fetch: typeof fetch
  /** Test hook `ATOMIC_PRISM_MODEL_RULES_URL`: where the conf model rules are read from. */
  rulesUrl?: string
  env?: NodeJS.ProcessEnv
  log?: (level: 'info' | 'warn', message: string) => void
  /** Test seam for the installed-pack choice. */
  selectInstalled?: typeof selectInstalledBackend
}

/** The pack a load on `atomic-prism` would run on now: the configured one when on disk, else the best installed. */
export async function currentPrismPack(
  deps: Pick<PrismWiringDeps, 'layout' | 'settings' | 'hardware' | 'selectInstalled'>
): Promise<{ version: string; backend: string } | null> {
  const configured = String(deps.settings.get('atomic-prism')['version_backend'] ?? '').trim()
  if (isConcreteVersionBackend(configured)) {
    const parsed = parseVersionBackend(configured)
    if (await resolveBackendExe(deps.layout, 'atomic-prism', parsed.version, parsed.backend)) return parsed
  }
  const selected = await (deps.selectInstalled ?? selectInstalledBackend)(
    deps.layout,
    'atomic-prism',
    deps.hardware
  )
  return selected ? { version: selected.version, backend: selected.backend } : null
}

/** The PrismML build a load on `atomic-prism` would run on now, with its declared capabilities. */
export async function installedPrism(
  deps: PrismWiringDeps,
  options: { offline: boolean }
): Promise<InstalledPrism> {
  const version = (await currentPrismPack(deps))?.version
  const build = version ? prismTagBuild(version) : null
  if (!version || build === null) return { build: null }
  const manifest = options.offline
    ? await deps.prismCatalog.cachedManifest()
    : (await deps.prismCatalog.catalog()).manifest
  const capabilities = findPrismRelease(manifest, version)?.capabilities
  return { build, ...(capabilities ? { capabilities } : {}) }
}

export function wirePrismCompatibility(deps: PrismWiringDeps): ModelCompatibilityService {
  const rules = new PrismModelRulesService({
    layout: deps.layout,
    fetch: deps.fetch,
    ...(deps.rulesUrl ? { url: deps.rulesUrl } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  })
  return new ModelCompatibilityService({
    rules,
    installedPrism: (options) => installedPrism(deps, options),
    fetch: deps.fetch,
    hfToken: () => hfToken(deps.env ?? process.env),
    ...(deps.log ? { log: deps.log } : {}),
  })
}
