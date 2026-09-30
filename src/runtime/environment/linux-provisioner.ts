/**
 * The Linux host recipe behind `EnvironmentService` (task 2.6): what a setup and a removal of a
 * managed engine actually do on a Linux machine with system Docker, one method per effect the
 * reducer (`state.ts`) can ask for.
 *
 * - **probe** reads the machine (`probeLinux`), judges it (`assessLinux`) against the descriptor the
 *   operation installs, and answers with a plan whose digest binds the consent: the system changes,
 *   the GPU set and whether the free space where the image lands suffices (carry item 1). When the plan needs the
 *   privileged step, the step carries the recipe's validated parameters and their digest, built by
 *   the recipe itself (`HostRecipeBinding`, task 2.5), plus a fresh single-use nonce.
 * - **verifyHostStep** probes again after a receipt; the helper's word is never the evidence.
 * - **prepare** pulls the small GPU-check image by digest and runs `nvidia-smi` in it on the chosen
 *   card (`--gpus device=<uuid>`) before a single byte of the engine image moves (design D6).
 * - **pull** pulls the engine image by the digest for this host's platform with byte progress;
 *   **verify** inspects it and confirms the digest; **activate** writes the installation record
 *   pinned to the descriptor (design D7).
 * - **remove** unloads a loaded session of the engine first (an injected callback; the provider is
 *   task 2.14), then removes this engine's own containers, the image by digest unless a foreign
 *   container uses it, the engine caches, the models only when asked, and the installation record.
 *   Docker, the toolkit, the group, repositories and anything not ours are never touched.
 *
 * Nothing here branches on which engine it is: the engine, image, probe image and requirements all
 * come from the descriptor and the operation's target. Every docker call goes through the one
 * executor core startup wired (`docker`), never a second one.
 */
import { randomUUID } from 'node:crypto'
import { AtomicCoreError } from '../../contracts/index.js'
import type {
  ContainerRuntimeStepParameters,
  ErrorBody,
  GpuFacts,
  ManagedAvailability,
  ManagedBlocker,
  ManagedHostStep,
  ManagedProgress,
  ManagedSystemChange,
  PlatformImage,
  RequirementPlan,
  RuntimeDescriptor,
  Sha256Digest,
} from '../../contracts/index.js'
import {
  containersUsingImage,
  inspectImage,
  pullImage,
  removeContainer,
  removeImage,
  runOnce,
  stopContainer,
  type DockerExec,
  type ExecutionRecord,
} from '../container/index.js'
import { canonicalDigest, planDigest } from './canonical-json.js'
import type { RuntimeDescriptorProvider } from './descriptor-provider.js'
import type { InstallationRecord, InstallationStore } from './installations.js'
import type { LinuxHost } from './linux-host.js'
import { assessLinux, compareDottedVersions, type LinuxAssessment, type LinuxBlocker } from './linux-plan.js'
import { daemonJsonSetsAddressPools } from './linux-docker-network.js'
import { probeLinux, type LinuxFacts } from './linux-probe.js'
import type { EffectFinding, EffectInventory } from './recovery.js'
import type { EnvironmentProvisioner, HostStepVerdict, ProvisionerProbe } from './service.js'
import type { EffectIntent } from './state.js'
import type { PersistedOperation } from './store.js'

/** The privileged recipe, as the host module builds it (`src/host/recipes`, task 2.5). Injected. */
export interface HostRecipeBinding {
  recipe_id: string
  recipe_digest: Sha256Digest
  /** The validated parameters for this plan; throws `MANAGED_HOST_STEP_INVALID` on a refusal. */
  parameters(
    plan: NonNullable<LinuxAssessment['install_plan']>,
    host: Omit<ContainerRuntimeStepParameters, 'components'>
  ): ContainerRuntimeStepParameters
  parametersDigest(parameters: ContainerRuntimeStepParameters): Sha256Digest
}

/** The startup Docker executor (`ManagedContainersHandle`), as far as setup and removal need it. */
export interface ProvisionerDocker {
  exec: DockerExec
  socketPath: string
  journal: { list(): ExecutionRecord[]; remove(containerId: string): Promise<void> }
}

/** What a probe of the host says about the environment, for the snapshot. */
export interface HostView {
  availability: ManagedAvailability
  gpus: GpuFacts[]
  blockers: ManagedBlocker[]
  selinux: boolean | null
}

/**
 * Unloads every loaded session of one engine, confirming the stop of its container (spec "Удаление
 * при загруженной модели"); rejects when a stop cannot be confirmed, holding nothing off then. On
 * success, new loads of that engine stay refused until the removal calls `release` — which it does
 * however it ends — so no load starts a container on an installation being removed (final review
 * M-1). The `tensorrt-llm` provider supplies the real one; the default reports nothing unloaded.
 */
export type UnloadEngineSessions = (engineId: string) => Promise<{ unloaded: number; release?: () => void }>

export const NOTHING_LOADED: UnloadEngineSessions = async () => ({ unloaded: 0 })

export interface LinuxProvisionerDeps {
  host: LinuxHost
  descriptors: RuntimeDescriptorProvider
  recipe: HostRecipeBinding
  /** The one executor of this core; null while this host has no docker CLI. */
  docker: () => Promise<ProvisionerDocker | null>
  installations: InstallationStore
  environmentId: string
  /** Removes this scope's engine caches of one descriptor (`removeEngineCaches`, task 2.12). */
  removeEngineCaches: (descriptorId: string) => Promise<void>
  /** Removes this scope's downloaded models of one engine; only for `retain_models: false`. */
  removeModels: (engineId: string) => Promise<void>
  unloadEngineSessions?: UnloadEngineSessions
  onAssessment?: (view: HostView) => void
  newId?: () => string
  now?: () => Date
  /** Container operations; the container module's by default, a fake in unit tests. */
  pull?: typeof pullImage
}

const ZERO_DIGEST: Sha256Digest = `sha256:${'0'.repeat(64)}`
/** Checkpoints at which part or all of the engine image is already in Docker's layer store. */
const PULL_PHASES: readonly string[] = ['pulling-image', 'verifying', 'activating']
const STOP_TIMEOUT_SECONDS = 10
const DIAGNOSTIC_TAIL = 1_000

type Platform = 'linux/amd64' | 'linux/arm64'

const platformFor = (architecture: string | null): Platform | null =>
  architecture === 'x86_64' ? 'linux/amd64' : architecture === 'aarch64' ? 'linux/arm64' : null

const tail = (text: string): string => (text.length > DIAGNOSTIC_TAIL ? text.slice(-DIAGNOSTIC_TAIL) : text)

/** How an image this operation pulled is named among its `owned_resource_ids`. */
export const ownedImageId = (image: PlatformImage): string => `image:${image.repository}@${image.digest}`

/** A structured `LinuxBlocker` on the wire. A relogin is its own code: the operation waits on it. */
export function toManagedBlocker(blocker: LinuxBlocker): ManagedBlocker {
  return {
    code: blocker.reason === 'relogin-required' ? 'MANAGED_RELOGIN_REQUIRED' : 'MANAGED_PREREQUISITE_BLOCKED',
    message: blocker.message,
    details: blocker.reason,
    reason: blocker.reason,
    ...(blocker.params === undefined ? {} : { params: blocker.params }),
    ...(blocker.commands === undefined ? {} : { commands: blocker.commands }),
  }
}

/**
 * The card the GPU check runs on, and the one a first load would pick: the largest memory among
 * cards new enough for the descriptor; a unified-memory card (no VRAM of its own) counts as zero.
 */
export function pickGpu(gpus: GpuFacts[], minimumComputeCapability: string): GpuFacts | null {
  const eligible = gpus.filter(
    (gpu) => compareDottedVersions(gpu.compute_capability, minimumComputeCapability) >= 0
  )
  return eligible.reduce<GpuFacts | null>(
    (best, gpu) => (best === null || (gpu.total_vram_bytes ?? 0) > (best.total_vram_bytes ?? 0) ? gpu : best),
    null
  )
}

/** Whether `inspectImage`'s answer names exactly `image` among its repo digests. */
export function imageMatchesDigest(inspected: unknown, image: PlatformImage): boolean {
  const digests = (inspected as { RepoDigests?: unknown } | null)?.RepoDigests
  return Array.isArray(digests) && digests.includes(`${image.repository}@${image.digest}`)
}

const blockedPlan = (
  record: PersistedOperation,
  environmentId: string,
  availability: ManagedAvailability,
  blocker: ManagedBlocker
): RequirementPlan => ({
  plan_digest: canonicalDigest({ blocked: blocker.code, reason: blocker.reason ?? null }),
  environment_id: environmentId,
  target: record.machine.operation.target,
  availability,
  recipe_id: 'none',
  recipe_digest: ZERO_DIGEST,
  descriptor_id: null,
  image_digest: null,
  adopts_existing_engine: false,
  system_changes: [],
  download_bytes: null,
  required_disk_bytes: null,
  docker_root_dir: null,
  free_disk_bytes: null,
  requires_elevation: false,
  may_require_relogin: false,
  may_require_reboot: false,
  blockers: [blocker],
  warnings: [],
})

export function createLinuxProvisioner(deps: LinuxProvisionerDeps): EnvironmentProvisioner {
  const newId = deps.newId ?? randomUUID
  const now = deps.now ?? (() => new Date())
  const pull = deps.pull ?? pullImage
  const unload = deps.unloadEngineSessions ?? NOTHING_LOADED

  /**
   * One probe of the machine shared by every caller that asks while it runs — recovery asks four
   * questions at once — and never reused after it settles: a receipt that arrives a second after a
   * probe must be judged against the machine as it is now.
   */
  let inFlight: Promise<LinuxFacts> | null = null
  const facts = (): Promise<LinuxFacts> => {
    inFlight ??= probeLinux(deps.host.probeDeps, deps.host.options()).finally(() => {
      inFlight = null
    })
    return inFlight
  }

  const dockerOrThrow = async (): Promise<ProvisionerDocker> => {
    const docker = await deps.docker()
    if (docker === null) {
      throw new AtomicCoreError(
        'MANAGED_PREREQUISITE_BLOCKED',
        'No docker CLI was found in the system directories (/usr/bin, /usr/local/bin, /bin).'
      )
    }
    return docker
  }

  const unavailable = (message: string, details?: string): ManagedBlocker => ({
    code: 'MANAGED_METADATA_INVALID',
    message,
    ...(details === undefined ? {} : { details }),
    reason: 'descriptor-unavailable',
  })

  /**
   * The descriptor a probe plans with. Once the user consented, only the consented descriptor, from
   * the cache (design D7) — never a newer one: a plan naming another descriptor is a new download
   * and has to be approved again. Before that: the one the operation's last plan or its request
   * named, when this core has it cached, otherwise the newest one it can get; the plan says which,
   * so the consent covers the real one.
   */
  const descriptorForProbe = async (
    record: PersistedOperation
  ): Promise<{ descriptor: RuntimeDescriptor } | { blocker: ManagedBlocker }> => {
    const consented = record.machine.consented?.descriptor_id ?? null
    if (consented !== null) {
      const pinned = await deps.descriptors.forInstallation(consented)
      return pinned.kind === 'available'
        ? { descriptor: pinned.descriptor }
        : { blocker: unavailable(pinned.error.message, consented) }
    }
    const preferred = record.requirement_plan?.descriptor_id ?? record.request.descriptor_id ?? null
    if (preferred !== null) {
      const pinned = await deps.descriptors.forInstallation(preferred)
      if (pinned.kind === 'available') return { descriptor: pinned.descriptor }
    }
    const latest = await deps.descriptors.forNewSetup()
    if (latest.kind === 'available') return { descriptor: latest.descriptor }
    return { blocker: unavailable(latest.error.message, latest.error.details) }
  }

  /**
   * The descriptor every effect after the consent works with: exactly the one the approved (or
   * carried) plan named, from the cache, and nothing else — no fallback to a newer descriptor
   * (review r1, item 2). Missing from the cache is a failure, not a reason to pick another.
   */
  const pinnedDescriptor = async (record: PersistedOperation): Promise<RuntimeDescriptor> => {
    const id = record.machine.consented?.descriptor_id ?? record.requirement_plan?.descriptor_id ?? null
    if (id === null) {
      throw new AtomicCoreError(
        'MANAGED_METADATA_INVALID',
        'This operation has no approved runtime descriptor.'
      )
    }
    const pinned = await deps.descriptors.forInstallation(id)
    if (pinned.kind !== 'available') {
      throw new AtomicCoreError('MANAGED_METADATA_INVALID', pinned.error.message, id)
    }
    return pinned.descriptor
  }

  const hostPlatform = async (): Promise<Platform> => {
    const uname = await deps.host.probeDeps.exec('uname', ['-m'])
    const platform = uname.code === 0 ? platformFor(uname.stdout.trim().replace(/^arm64$/, 'aarch64')) : null
    if (platform === null) {
      throw new AtomicCoreError(
        'MANAGED_PREREQUISITE_BLOCKED',
        'This machine’s architecture is not supported.'
      )
    }
    return platform
  }

  const installationId = (record: PersistedOperation): string | null => {
    const target = record.machine.operation.target
    return target.kind === 'runtime' ? target.installation_id : null
  }

  /** Absent by Docker's own answer. A failed inspect proves nothing, and is not "absent". */
  const imageAbsent = async (docker: ProvisionerDocker, image: PlatformImage): Promise<boolean> => {
    const inspected = await inspectImage(docker.exec, image).catch(() => null)
    return inspected !== null && !inspected.found
  }

  const imagePresent = async (image: PlatformImage): Promise<boolean> => {
    const docker = await deps.docker()
    if (docker === null) return false
    const inspected = await inspectImage(docker.exec, image).catch(() => null)
    return inspected !== null && inspected.found && imageMatchesDigest(inspected.value, image)
  }

  /** A removal plan: what is deleted, nothing about the host's readiness (a blocked host can still uninstall). */
  const removalProbe = async (record: PersistedOperation): Promise<ProvisionerProbe> => {
    const target = record.machine.operation.target
    if (target.kind !== 'runtime') {
      return {
        plan: blockedPlan(record, deps.environmentId, 'setup-required', {
          code: 'MANAGED_PREREQUISITE_BLOCKED',
          message: 'Only an engine installation can be removed; the container environment itself stays.',
          reason: 'remove-environment',
        }),
        host_step: null,
      }
    }
    const existing = await deps.installations.read(target.installation_id)
    const retainModels = record.request.retain_models !== false
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
      ...(retainModels
        ? []
        : [{ code: 'remove-models', text: `Delete the downloaded ${target.engine_id} models.` }]),
      { code: 'remove-installation', text: 'Forget the installation.' },
    ]
    const plan: RequirementPlan = {
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
      environment_id: deps.environmentId,
      target,
      availability: existing === null ? 'setup-required' : 'supported',
      recipe_id: 'none',
      recipe_digest: ZERO_DIGEST,
      descriptor_id: existing?.installation.active_descriptor_id ?? null,
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
    return { plan, host_step: null }
  }

  const setupProbe = async (record: PersistedOperation): Promise<ProvisionerProbe> => {
    const resolved = await descriptorForProbe(record)
    if ('blocker' in resolved) {
      const plan = blockedPlan(record, deps.environmentId, 'unsupported', resolved.blocker)
      deps.onAssessment?.({ availability: 'unsupported', gpus: [], blockers: plan.blockers, selinux: null })
      return { plan, host_step: null }
    }
    const { descriptor } = resolved
    const target = record.machine.operation.target
    const machine = await facts()
    const user = deps.host.options().user
    const platform = platformFor(machine.architecture)
    const image = platform === null ? null : descriptor.image[platform]
    const existing = target.kind === 'runtime' ? await deps.installations.read(target.installation_id) : null
    const present =
      target.kind === 'runtime' && image !== null && machine.docker.daemon_reachable
        ? await imagePresent(image)
        : false
    const readyInstallation =
      existing !== null &&
      existing.installation.status === 'ready' &&
      existing.installation.active_descriptor_id === descriptor.descriptor_id
    // What the engine image still needs on disk (review r1, item 1): nothing once it is there by
    // digest — whatever the installation record says, since an image deleted outside the app is
    // pulled again and needs the space again (review r2, item D); not checkable once a pull has
    // begun — Docker's layer store already holds part of it, and counting the free space that is
    // left against the whole image would fail every restart mid-pull. Otherwise the whole
    // `required_disk_bytes`. An environment-only setup pulls no engine image at all.
    // A ready installation of this descriptor on a daemon this probe cannot reach: whether its image
    // is there is unknown, which is not "absent" — no disk blocker on a guess (review r3, N4).
    const pullStarted = PULL_PHASES.includes(record.machine.checkpoint ?? 'checking')
    const presenceUnknown = readyInstallation && !machine.docker.daemon_reachable
    const stillNeeded =
      target.kind !== 'runtime' || present || pullStarted || presenceUnknown
        ? null
        : descriptor.required_disk_bytes
    const recipe = descriptor.recipes.find((entry) => entry.recipe_id === deps.recipe.recipe_id)
    const assessment = assessLinux(machine, {
      recipeId: deps.recipe.recipe_id,
      recipeDistributions: recipe?.distributions ?? [],
      minimumDriverVersion: descriptor.minimum_driver_version,
      minimumComputeCapability: descriptor.minimum_compute_capability,
      requiredDiskBytes: stillNeeded,
      currentUser: user,
    })

    const blockers = assessment.blockers.map(toManagedBlocker)
    if (target.kind === 'runtime' && target.engine_id !== descriptor.engine_id) {
      blockers.push({
        code: 'MANAGED_METADATA_INVALID',
        message: `The descriptor ${descriptor.descriptor_id} is for ${descriptor.engine_id}, not ${target.engine_id}.`,
        reason: 'engine-mismatch',
      })
    }
    if (existing !== null && existing.installation.active_descriptor_id !== descriptor.descriptor_id) {
      // An installation keeps its descriptor until an update, which is not part of this change
      // (design D7): a new release applies after remove + setup, never by setting up over it.
      blockers.push({
        code: 'MANAGED_OPERATION_CONFLICT',
        message: `This engine is already installed from ${String(existing.installation.active_descriptor_id)}; remove it before setting up ${descriptor.descriptor_id}.`,
        reason: 'installed-with-other-descriptor',
      })
    }

    let hostStep: ManagedHostStep | null = null
    const installPlan = assessment.install_plan
    if (blockers.length === 0 && installPlan !== null && installPlan.requires_elevation) {
      const distribution = machine.distribution
      try {
        if (distribution === null || (distribution.family !== 'apt' && distribution.family !== 'dnf')) {
          throw new AtomicCoreError(
            'MANAGED_HOST_STEP_INVALID',
            'The recipe has no package manager for this system.'
          )
        }
        const parameters = deps.recipe.parameters(installPlan, {
          user,
          arch: machine.architecture as 'x86_64' | 'aarch64',
          family: distribution.family,
          distro_id: distribution.id,
          version_id: distribution.version_id,
        })
        hostStep = {
          step_id: `host-step-${newId()}`,
          action: 'linux.install-container-runtime',
          recipe_id: deps.recipe.recipe_id,
          recipe_digest: deps.recipe.recipe_digest,
          parameters_digest: deps.recipe.parametersDigest(parameters),
          parameters,
          nonce: newId(),
          // Stamped with the real revision when the step is issued (`state.ts`, `afterConsent`).
          expected_operation_revision: 0,
        }
      } catch (error) {
        blockers.push({
          code: 'MANAGED_HOST_STEP_INVALID',
          message: error instanceof Error ? error.message : String(error),
          reason: 'recipe-refused-plan',
        })
      }
    }

    const systemChanges: ManagedSystemChange[] = (installPlan?.system_changes ?? []).map((change) => ({
      code: change.code,
      text: change.text,
      ...(change.params === undefined ? {} : { params: change.params }),
    }))
    const availability: ManagedAvailability =
      blockers.length > 0
        ? assessment.availability === 'setup-required'
          ? 'prerequisite-blocked'
          : assessment.availability
        : readyInstallation
          ? 'supported'
          : assessment.availability
    const plan: RequirementPlan = {
      plan_digest: planDigest({
        target,
        recipe_id: deps.recipe.recipe_id,
        recipe_digest: deps.recipe.recipe_digest,
        adopts_existing_engine: assessment.adopts_existing_engine,
        system_changes: systemChanges,
        requires_elevation: installPlan?.requires_elevation ?? false,
        may_require_relogin: installPlan?.may_require_relogin ?? false,
        may_require_reboot: false,
        descriptor:
          image === null ? null : { descriptor_id: descriptor.descriptor_id, image_digest: image.digest },
        host: {
          gpu_ids: machine.gpus.map((gpu) => gpu.gpu_id).sort(),
          disk_sufficient:
            stillNeeded === null
              ? true
              : machine.free_disk_bytes === null
                ? null
                : machine.free_disk_bytes >= stillNeeded,
          docker_root_dir: machine.docker.docker_root_dir,
        },
      }),
      environment_id: deps.environmentId,
      target,
      availability,
      recipe_id: deps.recipe.recipe_id,
      recipe_digest: deps.recipe.recipe_digest,
      descriptor_id: descriptor.descriptor_id,
      image_digest: target.kind === 'runtime' ? (image?.digest ?? null) : null,
      adopts_existing_engine: assessment.adopts_existing_engine,
      system_changes: systemChanges,
      download_bytes: descriptor.download_bytes,
      required_disk_bytes: descriptor.required_disk_bytes,
      // Where and how much the probe measured — the numbers `insufficient-disk` was judged on — or
      // neither when the read failed (task 2.22, R-core-6). Not in `plan_digest`: its `host` keeps
      // `docker info`'s own `DockerRootDir` and `disk_sufficient`, exactly as before, so reporting
      // them changes no digest and asks for no new consent.
      docker_root_dir: machine.free_disk_bytes === null ? null : machine.free_disk_path,
      free_disk_bytes: machine.free_disk_bytes,
      requires_elevation: installPlan?.requires_elevation ?? false,
      may_require_relogin: installPlan?.may_require_relogin ?? false,
      may_require_reboot: false,
      blockers,
      // What the plan's reader should know before consenting (task 2.23, F-4). Not in `plan_digest`:
      // a warning asks for no new consent, and its input (the routing table, a VPN switched on or
      // off) moves on its own; the consent covers what the plan changes, which a warning never does.
      warnings: assessment.warnings.map((warning) => ({
        code: warning.code,
        text: warning.text,
        ...(warning.params === undefined ? {} : { params: warning.params }),
      })),
    }
    deps.onAssessment?.({
      availability,
      gpus: machine.gpus,
      blockers,
      selinux: machine.docker.daemon_reachable ? machine.docker.selinux : null,
    })
    return { plan, host_step: hostStep, image_present: present }
  }

  const probe = (record: PersistedOperation): Promise<ProvisionerProbe> =>
    record.request.kind === 'remove' ? removalProbe(record) : setupProbe(record)

  const needsRelogin = async (record: PersistedOperation): Promise<boolean> => {
    if (record.request.kind === 'remove') return false
    const machine = await facts()
    // Carry item 7: the group is configured but not in this session, and the daemon is running —
    // only a sign-in is missing. Root never needs one (design D4).
    return (
      !machine.docker.daemon_reachable &&
      machine.docker_group.configured === true &&
      !machine.docker_group.effective &&
      machine.docker.service_active === true &&
      deps.host.options().user !== 'root'
    )
  }

  const inventory: EffectInventory = {
    async inspect(effect: EffectIntent, record: PersistedOperation): Promise<EffectFinding> {
      if (record.request.kind === 'remove') return { kind: 'absent' }
      try {
        if (effect.kind === 'pull-image' || effect.kind === 'verify') {
          const descriptor = await pinnedDescriptor(record)
          const image = descriptor.image[await hostPlatform()]
          return (await imagePresent(image))
            ? { kind: 'completed', owned_resource_ids: [] }
            : { kind: 'absent' }
        }
        if (effect.kind === 'activate') {
          const id = installationId(record)
          const existing = id === null ? null : await deps.installations.read(id)
          // Compared by id, never resolved: a cache entry gone since the activation must not make
          // a committed activation look undone (review r2, item C).
          const planned =
            record.machine.consented?.descriptor_id ?? record.requirement_plan?.descriptor_id ?? null
          // Status too (N-1), not only the id: a removal that failed part-way leaves the record
          // `removing` with the same descriptor id it activated. Treating that as a completed
          // activation would let recovery skip re-running it, and the record would never reach
          // `ready` again.
          return existing !== null &&
            existing.installation.active_descriptor_id === planned &&
            existing.installation.status === 'ready'
            ? { kind: 'completed', owned_resource_ids: [] }
            : { kind: 'absent' }
        }
      } catch {
        // Nothing this core can check (no descriptor cached, no architecture): the effect runs
        // again, and fails there with its own reason if it still cannot.
      }
      return { kind: 'absent' }
    },
    needsRelogin,
    needsReboot: async () => false,
    async verifyCompletedSteps(record: PersistedOperation): Promise<string[]> {
      const steps = record.machine.operation.completed_step_ids
      if (steps.length === 0) return []
      const machine = await facts()
      // What the step installed is still there; otherwise it no longer counts as done.
      return machine.docker.cli && machine.toolkit_installed ? steps : []
    },
    async currentPlanDigest(record: PersistedOperation): Promise<Sha256Digest | null> {
      return (await probe(record).catch(() => null))?.plan.plan_digest ?? null
    },
  }

  return {
    probe: (record) => probe(record),

    async addressPoolsConfigured(): Promise<boolean | 'unknown'> {
      // Read-only, the same contract as the probe's own read: null is "no file", a rejection "unreadable".
      const read = await deps.host.probeDeps.readFile('/etc/docker/daemon.json').then(
        (text) => ({ text, unreadable: false }),
        () => ({ text: null, unreadable: true })
      )
      return daemonJsonSetsAddressPools(read)
    },

    async verifyHostStep(record: PersistedOperation): Promise<HostStepVerdict> {
      const answer = await setupProbe(record)
      const { blockers } = answer.plan
      if (blockers.length === 1 && blockers[0]?.code === 'MANAGED_RELOGIN_REQUIRED') {
        return { prerequisites_met: false, needs_relogin: true, error: null }
      }
      if (blockers.length > 0) {
        const first = blockers[0] as ManagedBlocker
        return {
          prerequisites_met: false,
          needs_relogin: false,
          error: {
            code: first.code,
            message: `The system change was reported as done, but the machine says: ${blockers
              .map((entry) => entry.message)
              .join(' ')}`,
            details: blockers.map((entry) => entry.reason ?? entry.code).join(','),
          },
        }
      }
      if (answer.host_step !== null) {
        const missing: ErrorBody = {
          code: 'MANAGED_PREREQUISITE_BLOCKED',
          message: `The system change was reported as done, but the machine still needs: ${answer.plan.system_changes
            .map((change) => change.text)
            .join(' ')}`,
          details: answer.plan.system_changes.map((change) => change.code).join(','),
        }
        return { prerequisites_met: false, needs_relogin: false, error: missing }
      }
      return { prerequisites_met: true, needs_relogin: false, error: null }
    },

    async prepare(
      record: PersistedOperation,
      signal: AbortSignal,
      own: (resourceIds: string[]) => Promise<void>
    ): Promise<void> {
      const descriptor = await pinnedDescriptor(record)
      const machine = await facts()
      const platform = platformFor(machine.architecture)
      if (platform === null) {
        throw new AtomicCoreError(
          'MANAGED_PREREQUISITE_BLOCKED',
          'This machine’s architecture is not supported.'
        )
      }
      const gpu = pickGpu(machine.gpus, descriptor.minimum_compute_capability)
      if (gpu === null) {
        throw new AtomicCoreError(
          'MANAGED_PREREQUISITE_BLOCKED',
          `No GPU with compute capability ${descriptor.minimum_compute_capability} or newer was found.`
        )
      }
      const docker = await dockerOrThrow()
      const probeImage = descriptor.probe_image[platform]
      // Only a GPU-check image this setup pulls itself is its to remove later. Whether it was absent
      // is recorded on the operation before the pull, so a core that dies between the pull and the
      // activation still knows (review r2, item B); an image the user already had never is.
      if (await imageAbsent(docker, probeImage)) await own([ownedImageId(probeImage)])
      await pull(probeImage, { socketPath: docker.socketPath, signal, verify: docker.exec })
      const result = await runOnce(docker.exec, {
        image: probeImage,
        gpuUuid: gpu.gpu_id,
        command: ['nvidia-smi', '--query-gpu=uuid', '--format=csv,noheader'],
      })
      if (result.code !== 0 || !result.stdout.includes(gpu.gpu_id)) {
        // Toolkit diagnostics, so the failure says where to look: what the container printed, and
        // what the host probe says about the runtime Docker is using.
        throw new AtomicCoreError(
          'MANAGED_PREREQUISITE_BLOCKED',
          `The GPU ${gpu.name} is not visible inside a container: the NVIDIA Container Toolkit did not pass it through. The engine image was not downloaded.`,
          [
            `gpu=${gpu.gpu_id}`,
            `exit=${String(result.code)}`,
            `toolkit_installed=${String(machine.toolkit_installed)}`,
            `gpu_runtime=${String(machine.docker.gpu_runtime)}`,
            `stdout=${tail(result.stdout.trim())}`,
            `stderr=${tail(result.stderr.trim())}`,
          ].join('\n')
        )
      }
    },

    async pull(
      record: PersistedOperation,
      onProgress: (progress: ManagedProgress) => void,
      signal: AbortSignal
    ): Promise<void> {
      const descriptor = await pinnedDescriptor(record)
      const image = descriptor.image[await hostPlatform()]
      const docker = await dockerOrThrow()
      const label = 'Downloading the engine image'
      onProgress({ label, completed: 0, total: descriptor.download_bytes, unit: 'bytes' })
      await pull(image, {
        socketPath: docker.socketPath,
        signal,
        knownTotalBytes: descriptor.download_bytes,
        verify: docker.exec,
        onProgress: (progress) =>
          onProgress({ label, completed: progress.current, total: progress.total, unit: 'bytes' }),
      })
    },

    async verify(record: PersistedOperation): Promise<void> {
      const target = record.machine.operation.target
      if (target.kind === 'environment') {
        const machine = await facts()
        if (!machine.docker.daemon_reachable || !machine.docker.gpu_runtime) {
          throw new AtomicCoreError(
            'MANAGED_PREREQUISITE_BLOCKED',
            'Docker does not answer with a GPU runtime any more.'
          )
        }
        return
      }
      const descriptor = await pinnedDescriptor(record)
      const image = descriptor.image[await hostPlatform()]
      const docker = await dockerOrThrow()
      const inspected = await inspectImage(docker.exec, image)
      if (!inspected.found || !imageMatchesDigest(inspected.value, image)) {
        throw new AtomicCoreError(
          'MANAGED_IDENTITY_MISMATCH',
          'The engine image on this machine does not carry the digest the descriptor pins.',
          `${image.repository}@${image.digest}`
        )
      }
    },

    async unloadResident(): Promise<void> {
      // Updates are a later change; a setup never reaches this.
    },

    async activate(record: PersistedOperation): Promise<void> {
      const target = record.machine.operation.target
      if (target.kind !== 'runtime') return
      const descriptor = await pinnedDescriptor(record)
      const platform = await hostPlatform()
      const probeImage = descriptor.probe_image[platform]
      // Ours if this operation pulled it, or if the installation it replaces already recorded that
      // an earlier setup did (a repeat setup finds it present and claims nothing; review r3, N3).
      // An earlier attempt that never activated leaves no record to carry, so its image stays the
      // user's to remove: the safe direction.
      const previous = await deps.installations.read(target.installation_id)
      const ownsProbe =
        record.owned_resource_ids.includes(ownedImageId(probeImage)) ||
        previous?.probe_image?.digest === probeImage.digest
      const installation: InstallationRecord = {
        schema_version: 1,
        installation: {
          installation_id: target.installation_id,
          engine_id: target.engine_id,
          environment_id: record.machine.operation.environment_id,
          active_descriptor_id: descriptor.descriptor_id,
          candidate_descriptor_id: null,
          availability: 'supported',
          status: 'ready',
        },
        image: descriptor.image[platform],
        ...(ownsProbe ? { probe_image: probeImage } : {}),
        platform,
        installed_at: now().toISOString(),
      }
      await deps.installations.write(installation)
    },

    async remove(record: PersistedOperation): Promise<void> {
      const target = record.machine.operation.target
      if (target.kind !== 'runtime') {
        throw new AtomicCoreError('INVALID_ARGUMENT', 'Only an engine installation can be removed.')
      }
      const existing = await deps.installations.read(target.installation_id)
      // A loaded model goes first, with its container confirmed stopped: removing the image under a
      // running container is not something Docker allows, and a GPU must never be left held. Loads
      // of the engine stay held off until this removal ends, whichever way.
      const hold = await unload(target.engine_id)
      try {
        const docker = await deps.docker()
        if (docker !== null) {
          // Our own containers of this engine that outlived their session (a crash, a failed load).
          for (const container of docker.journal
            .list()
            .filter((entry) => entry.engine_id === target.engine_id)) {
            const stopped = await stopContainer(docker.exec, container.container_id, STOP_TIMEOUT_SECONDS)
            if (!stopped.confirmed) {
              throw new AtomicCoreError(
                'MANAGED_STOP_UNCONFIRMED',
                'A container of this engine could not be confirmed stopped, so nothing was removed.',
                `${container.container_id}: ${stopped.reason}`
              )
            }
            await removeContainer(docker.exec, container.container_id)
            await docker.journal.remove(container.container_id)
          }
          if (existing !== null) {
            // No longer `ready` from here on (final review I-1): once the image may be gone, a record
            // that still said `ready` would send every load to `docker create` for a missing image,
            // and a step that fails below (a cache the user cannot delete) would leave it that way.
            // `removing` refuses loads as "not ready" and keeps the removal retryable.
            if (existing.installation.status !== 'removing') {
              await deps.installations.write({
                ...existing,
                installation: { ...existing.installation, status: 'removing' },
              })
            }
            // Only the digest this installation pulled, and only when nobody else's container uses
            // it — a foreign container keeps the image, and Docker would refuse anyway.
            const users = await containersUsingImage(docker.exec, existing.image)
            if (users.length === 0) await removeImage(docker.exec, existing.image)
            // The GPU-check image too, unless another installation recorded it or a container uses it.
            const probe = existing.probe_image
            if (probe !== undefined) {
              const others = (await deps.installations.list()).filter(
                (entry) =>
                  entry.installation.installation_id !== target.installation_id &&
                  entry.probe_image?.digest === probe.digest
              )
              if (others.length === 0 && (await containersUsingImage(docker.exec, probe)).length === 0) {
                await removeImage(docker.exec, probe)
              }
            }
          }
        }

        const descriptorId = existing?.installation.active_descriptor_id ?? null
        if (descriptorId !== null) await deps.removeEngineCaches(descriptorId)
        if (record.request.retain_models === false) await deps.removeModels(target.engine_id)
        await deps.installations.remove(target.installation_id)
      } finally {
        hold.release?.()
      }
    },

    async cleanup(): Promise<void> {
      // A cancelled setup created nothing that is its alone to undo: packages a host step installed
      // stay (they changed the machine with consent), a partly pulled image is Docker's layer cache,
      // and the installation record is only ever written by the last step.
    },

    inventory,
  }
}
