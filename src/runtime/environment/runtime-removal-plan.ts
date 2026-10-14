/**
 * The plan to remove one engine's installation, the same on Linux and Windows (moved out of
 * `linux-provisioner.ts`; Windows acceptance, 2026-10-13). A removal is about what is installed: it
 * names the installation's own descriptor and image and judges nothing against conf or the
 * environment. Planning it as a setup — the newest descriptor, the host assessment — would stop it
 * with "installed from another descriptor" as soon as conf published a newer release, so the engine
 * could never be removed (and never updated, which is a removal and a new setup).
 */
import type {
  ManagedOperationTarget,
  ManagedSystemChange,
  RequirementPlan,
  Sha256Digest,
} from '../../contracts/index.js'
import { canonicalDigest } from './canonical-json.js'
import type { InstallationStore } from './installations.js'
import type { PersistedOperation } from './store.js'
import { otherEngines, storeModelsChange } from './store-models.js'

const ZERO_DIGEST: Sha256Digest = `sha256:${'0'.repeat(64)}`

export async function runtimeRemovalPlan(options: {
  record: PersistedOperation
  target: Extract<ManagedOperationTarget, { kind: 'runtime' }>
  environmentId: string
  installations: Pick<InstallationStore, 'read' | 'list'>
}): Promise<RequirementPlan> {
  const { record, target, environmentId, installations } = options
  const existing = await installations.read(target.installation_id)
  const retainModels = record.request.retain_models !== false
  const usedBy = await otherEngines(installations, target)
  const changes: ManagedSystemChange[] = [
    {
      code: 'unload-sessions',
      text: `Unload any loaded ${target.engine_id} model, waiting until its container has stopped.`,
    },
    { code: 'remove-containers', text: `Remove this app's own ${target.engine_id} containers.` },
    ...(existing === null
      ? []
      : [
          {
            code: 'remove-image',
            text: `Remove the engine image ${existing.image.repository}@${existing.image.digest}, unless another container still uses it.`,
            params: { image: `${existing.image.repository}@${existing.image.digest}` },
          },
          ...(existing.probe_image === undefined
            ? []
            : [
                {
                  code: 'remove-probe-image',
                  text: `Remove the GPU check image ${existing.probe_image.repository}@${existing.probe_image.digest}, unless something else still uses it.`,
                  params: { image: `${existing.probe_image.repository}@${existing.probe_image.digest}` },
                },
              ]),
          {
            code: 'remove-engine-caches',
            text: 'Remove the engine caches built for this installation.',
            params: { descriptor_id: existing.installation.active_descriptor_id ?? '' },
          },
        ]),
    ...storeModelsChange(retainModels, usedBy),
    { code: 'remove-installation', text: 'Forget the installation.' },
  ]
  return {
    plan_digest: canonicalDigest({
      kind: 'remove',
      target,
      installation:
        existing === null
          ? null
          : { descriptor_id: existing.installation.active_descriptor_id, image: existing.image },
      retain_models: retainModels,
      system_changes: changes,
    }),
    environment_id: environmentId,
    target,
    availability: existing === null ? 'setup-required' : 'supported',
    recipe_id: 'none',
    recipe_digest: ZERO_DIGEST,
    descriptor_id: existing?.installation.active_descriptor_id ?? null,
    // A removal judges nothing against the environment: no manifest is read or pinned.
    environment_manifest_id: null,
    image_digest: existing?.image.digest ?? null,
    adopts_existing_engine: true,
    system_changes: changes,
    download_bytes: null,
    required_disk_bytes: null,
    // A removal reads nothing off the disk.
    docker_root_dir: null,
    free_disk_bytes: null,
    requires_elevation: false,
    may_require_relogin: false,
    may_require_reboot: false,
    blockers: [],
    warnings: [],
  }
}
