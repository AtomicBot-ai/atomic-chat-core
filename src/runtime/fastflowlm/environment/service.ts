import type { FastFlowLmAccelerators } from '../../../contracts/index.js'
import type { FlmManifest } from './manifest.js'
import { preparationPlan, type PreparationHost } from './plan.js'

interface Sources {
  host: () => Promise<PreparationHost>
  manifest: () => Promise<FlmManifest | null>
  selectedBuild: () => Promise<string | null>
}
export async function probePreparation(
  facts: FastFlowLmAccelerators,
  platform: string,
  arch: string,
  sources: Sources
) {
  const local = {
    os: platform === 'win32' ? 'windows' : platform,
    arch,
    version: null,
    kernel_release: null,
    distribution: null,
    mutable: null,
  }
  if (
    facts.ready ||
    !facts.devices.some((d) => d.generation === 'xdna2') ||
    facts.blockers.some((b) =>
      [
        'device-busy',
        'privileged-account',
        'account-unknown',
        'runtime-identity-unknown',
        'ambiguous-npu',
        'probe-inconclusive',
      ].includes(b)
    )
  )
    return preparationPlan(facts, local, null)
  const host = await sources.host()
  const offline = preparationPlan(facts, host, null)
  if (!offline.blockers.includes('manifest-unavailable')) return offline
  const manifest = await sources.manifest()
  const build = facts.engine_version ?? (manifest?.recipes.length ? await sources.selectedBuild() : null)
  return preparationPlan(facts, host, manifest, build)
}
