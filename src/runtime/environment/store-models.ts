/**
 * What a removal of one managed engine does with the managed model store (change `add-vllm-runtime`,
 * design D13; spec `managed-runtime-environment`, "Удаление установки движка"): the models are every
 * managed engine's, so `retain_models: false` deletes them only when no installation of another engine
 * is left after this one goes. Otherwise they stay, and the plan says which engines still use them.
 * Shared by the Linux and the Windows provisioner, which must agree on it exactly.
 */
import type { ManagedOperationTarget, ManagedSystemChange } from '../../contracts/index.js'
import type { InstallationStore } from './installations.js'

/**
 * The engines of the installations other than the one being removed that use the models: installed
 * once (an active descriptor) and not being removed. A setup that failed before it ever installed
 * anything uses nothing.
 */
export async function otherEngines(
  installations: Pick<InstallationStore, 'list'>,
  target: Extract<ManagedOperationTarget, { kind: 'runtime' }>
): Promise<string[]> {
  const records = await installations.list()
  const engines = records
    .map((record) => record.installation)
    .filter((installation) => installation.installation_id !== target.installation_id)
    .filter(
      (installation) => installation.active_descriptor_id !== null && installation.status !== 'removing'
    )
    .map((installation) => installation.engine_id)
  return [...new Set(engines)].sort()
}

/** The plan's line about the models, if the request asks to delete them. */
export function storeModelsChange(retainModels: boolean, usedBy: readonly string[]): ManagedSystemChange[] {
  if (retainModels) return []
  if (usedBy.length > 0) {
    return [
      {
        code: 'keep-models',
        text: `The downloaded models stay: ${usedBy.join(', ')} still uses them.`,
        params: { engines: usedBy.join(',') },
      },
    ]
  }
  return [{ code: 'remove-models', text: 'Delete the downloaded models of the managed engines.' }]
}
