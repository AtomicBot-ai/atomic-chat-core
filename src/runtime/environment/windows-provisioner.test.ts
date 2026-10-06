import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import type { BeginOperation, RuntimeDescriptor, WindowsEnvironmentManifest } from '../../contracts/index.js'
import {
  ENABLE_WSL_PARAMETERS_DIGEST,
  ENABLE_WSL_RECIPE_DIGEST,
  ENABLE_WSL_RECIPE_ID,
  INSTALL_CONTAINER_RUNTIME_RECIPE_DIGEST,
  INSTALL_CONTAINER_RUNTIME_RECIPE_ID,
  installContainerRuntimeParametersDigest,
  parametersFromPlan,
  type InstallContainerRuntimeParameters,
} from '../../host/recipes/index.js'
import {
  fakeWindows,
  type FakeWindows,
  type FakeWindowsMachine,
} from '../../../test/helpers/fake-windows-host.js'
import type { FakeWslGuest } from '../../../test/helpers/fake-wsl.mjs'
import { readLinuxProbeFixture } from '../../../test/helpers/linux-probe-fixtures.js'
import { readRuntimeFixture } from '../../../test/helpers/runtime-fixtures.js'
import { parseRuntimeDescriptor } from './descriptor.js'
import { TENSORRT_LLM_DESCRIPTOR_SOURCE, type RuntimeDescriptorProvider } from './descriptor-provider.js'
import { parseWindowsEnvironmentManifest } from './environment-manifest.js'
import type { EnvironmentManifestProvider } from './environment-manifest-provider.js'
import { InstallationStore } from './installations.js'
import type { ExecutionRecord } from '../container/index.js'
import type { HostRecipeBinding, HostView } from './linux-provisioner.js'
import { EnvironmentService } from './service.js'
import { startOperation } from './state.js'
import { OperationStore, type PersistedOperation } from './store.js'
import { FakeManagedFs } from '../../../test/helpers/managed-store-fs.js'
import type { WindowsEnvironmentRecord } from './windows-environment-record.js'
import { distributionDirectory } from './windows-host.js'
import { createWindowsProvisioner, type WindowsProvisionerDeps } from './windows-provisioner.js'

const DESCRIPTOR = parseRuntimeDescriptor(
  readRuntimeFixture('tensorrt-llm-1.2.1-r2.json')
) as RuntimeDescriptor
const MANIFEST = parseWindowsEnvironmentManifest(readRuntimeFixture('environments/windows.json'))
/** The arm64 manifest's shape: its own id, an aarch64 guest. */
const ARM_MANIFEST = parseWindowsEnvironmentManifest({
  ...(readRuntimeFixture('environments/windows.json') as Record<string, unknown>),
  manifest_id: 'windows-arm64-r1',
  rootfs: {
    url: 'https://example.org/ubuntu-24.04.5-wsl-arm64.wsl',
    sha256: 'a'.repeat(64),
    distribution: { id: 'ubuntu', version_id: '24.04', arch: 'aarch64' },
  },
})
const GPU = 'GPU-1c6a2b3c-0000-4000-8000-000000000001'
const GIB = 1024 ** 3
const DISTRO_DIR = distributionDirectory('C:\\Users\\ada\\AppData\\Local')

const GUEST_RECIPE: HostRecipeBinding = {
  recipe_id: INSTALL_CONTAINER_RUNTIME_RECIPE_ID,
  recipe_digest: INSTALL_CONTAINER_RUNTIME_RECIPE_DIGEST,
  parameters: (plan, host) => parametersFromPlan(plan, host),
  parametersDigest: (parameters) =>
    installContainerRuntimeParametersDigest(parameters as InstallContainerRuntimeParameters),
}

const TARGET = { kind: 'runtime' as const, installation_id: 'tensorrt-llm', engine_id: 'tensorrt-llm' }

/** A guest the recipe has finished: Ubuntu 24.04 with systemd, Docker, the toolkit and a CDI spec. */
const readyGuest = (over: Partial<FakeWslGuest> = {}): FakeWslGuest => ({
  files: {
    '/etc/os-release': readLinuxProbeFixture('os-release/ubuntu-24.04.txt'),
    '/proc/meminfo': 'MemTotal:       16303452 kB\nMemFree:        15000000 kB\n',
  },
  dirs: ['/', '/var', '/var/lib', '/var/lib/docker', '/run/systemd/system'],
  free_disk_bytes: 900 * GIB,
  nvml_version: '590.48.01',
  host: {
    user: 'root',
    // The guest's `nvidia-smi` names the Windows driver's number: never comparable with Linux's.
    driver: '591.44',
    gpus: [{ uuid: GPU, name: 'NVIDIA GeForce RTX 4070', cc: '8.9', total_mib: 12282, free_mib: 11000 }],
    docker: { installed: true, reachable: true, service_active: true, gpu_runtime: true },
    toolkit: true,
    cdi: true,
    gpu_visible_in_container: true,
    images: [],
    containers: [],
  },
  ...over,
})

/** A fresh Windows 11 desktop: an RTX 4070 and its driver, no WSL at all. */
const freshWindows = (): FakeWindowsMachine => ({
  wsl: { installed: false, distributions: [], guests: {} },
  machine: 'x86_64',
  release: '10.0.22631',
  elevated: false,
  virtualization: { firmware: true, hypervisor: false },
  nvidia: {
    driver: '591.44',
    gpus: [{ uuid: GPU, name: 'NVIDIA GeForce RTX 4070', cc: '8.9', total_mib: 12282, free_mib: 11000 }],
  },
  wslconfig: null,
  volume_free_bytes: 500 * GIB,
  vhdx_bytes: null,
})

/** What a freshly imported Ubuntu 24.04 rootfs is: systemd, the NVIDIA libraries WSL provides, nothing else. */
const freshGuest = (): FakeWslGuest => {
  const guest = readyGuest({ users: [] })
  guest.host = {
    ...guest.host,
    docker: { installed: false, reachable: false, service_active: false, gpu_runtime: false },
    toolkit: false,
    cdi: false,
  }
  return guest
}

/** The same machine with WSL 2.4.4 and the user's own Ubuntu as default, before Atomic Chat's import. */
const wslWindows = (): FakeWindowsMachine => ({
  ...freshWindows(),
  wsl: {
    installed: true,
    wsl_version: '2.4.4.0',
    ready: true,
    distributions: [{ name: 'Ubuntu', state: 'Stopped', version: 2, is_default: true }],
    guests: {},
    import_guest: freshGuest(),
  },
  virtualization: { firmware: false, hypervisor: true },
})

/** After the import: Atomic Chat's own distribution registered and recorded, its guest ready. */
const importedWindows = (guest: FakeWslGuest = readyGuest()): FakeWindowsMachine => {
  const machine = wslWindows()
  return {
    ...machine,
    wsl: {
      ...machine.wsl,
      distributions: [
        ...(machine.wsl.distributions ?? []),
        { name: 'AtomicChat', state: 'Stopped', version: 2, is_default: false },
      ],
      guests: { AtomicChat: guest },
    },
    vhdx_bytes: 30 * GIB,
  }
}

const RECORD: WindowsEnvironmentRecord = {
  schema_version: 1,
  executor: 'wsl-docker',
  distribution: { name: 'AtomicChat', path: DISTRO_DIR },
  manifest_id: 'windows-r1',
  imported_at: '2026-10-01T00:00:00.000Z',
  marker: 'marker-0001',
}

const record = (request: Partial<BeginOperation> = {}): PersistedOperation => {
  const input: BeginOperation = {
    request_id: 'req-1',
    target: TARGET,
    kind: 'setup',
    descriptor_id: DESCRIPTOR.descriptor_id,
    ...request,
  }
  const started = startOperation(
    {
      operation_id: 'op-1',
      request_id: input.request_id,
      environment_id: 'default',
      instance_id: 'core-1',
      target: input.target,
      kind: input.kind,
    },
    { next_effect_id: 'effect-1' }
  )
  return {
    machine: { ...started.state, consented: null },
    request_digest: `sha256:${'a'.repeat(64)}`,
    request: input,
    requirement_plan: null,
    accepted_receipt_digests: {},
    completed_effect_ids: [],
    owned_resource_ids: [],
    owner_pid: null,
    owner_process_start_id: null,
  }
}

/** A Windows manifest provider whose latest is `latest` (null: none) and whose cache also holds `cached`. */
const manifestsOf = (
  latest: WindowsEnvironmentManifest | null,
  cached: WindowsEnvironmentManifest[] = []
): EnvironmentManifestProvider<'windows'> => {
  const store = [...(latest === null ? [] : [latest]), ...cached]
  const missing = (details?: string) => ({
    kind: 'unavailable' as const,
    error: new AtomicCoreError('MANAGED_METADATA_INVALID', 'No environment manifest is available.', details),
  })
  return {
    latest: vi.fn(async () =>
      latest === null ? missing() : { kind: 'available' as const, manifest: latest }
    ),
    pinned: vi.fn(async (id: string) => {
      const found = store.find((manifest) => manifest.manifest_id === id)
      return found === undefined ? missing(id) : { kind: 'available' as const, manifest: found }
    }),
  }
}

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'windows-provisioner-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

interface Harness {
  windows: FakeWindows
  deps: WindowsProvisionerDeps
  views: HostView[]
  written: WindowsEnvironmentRecord[]
  downloads: { url: string; destination: string }[]
  removed: string[]
  recipes: unknown[]
  current: () => WindowsEnvironmentRecord | null
  leases: { count: number; peak: number }
}

const harness = (
  machine: FakeWindowsMachine,
  options: {
    record?: WindowsEnvironmentRecord | null
    manifests?: EnvironmentManifestProvider<'windows'>
    rootfsTampered?: boolean
    descriptors?: RuntimeDescriptorProvider
  } = {}
): Harness => {
  const windows = fakeWindows(machine)
  const views: HostView[] = []
  const written: WindowsEnvironmentRecord[] = []
  const downloads: { url: string; destination: string }[] = []
  const removed: string[] = []
  const recipes: unknown[] = []
  const journal: ExecutionRecord[] = []
  const leases = { count: 0, peak: 0 }
  let current = options.record ?? null
  const descriptors: RuntimeDescriptorProvider = {
    engines: [TENSORRT_LLM_DESCRIPTOR_SOURCE],
    forNewSetup: async () => ({ kind: 'available', descriptor: DESCRIPTOR }),
    forInstallation: async (id) =>
      id === DESCRIPTOR.descriptor_id
        ? { kind: 'available', descriptor: DESCRIPTOR }
        : { kind: 'unsupported', error: new Error('not cached') as never },
    cachedForNewSetup: async () => ({ kind: 'available', descriptor: DESCRIPTOR }),
  }
  const deps: WindowsProvisionerDeps = {
    host: windows.host,
    descriptors: options.descriptors ?? descriptors,
    environmentManifests: options.manifests ?? manifestsOf(MANIFEST),
    records: {
      read: async () => current,
      write: async (next) => {
        written.push(next)
        current = next
      },
      remove: async () => {
        current = null
      },
    },
    guestRecipe: GUEST_RECIPE,
    enableWsl: {
      recipe_id: ENABLE_WSL_RECIPE_ID,
      recipe_digest: ENABLE_WSL_RECIPE_DIGEST,
      parameters_digest: ENABLE_WSL_PARAMETERS_DIGEST,
    },
    installations: new InstallationStore(root),
    environmentId: 'default',
    downloadRootfs: async (rootfs, destination) => {
      downloads.push({ url: rootfs.url, destination })
      if (options.rootfsTampered === true) {
        throw new AtomicCoreError(
          'MANAGED_IDENTITY_MISMATCH',
          'The downloaded rootfs does not match its sha256.',
          rootfs.sha256
        )
      }
    },
    removeFile: async (path) => {
      removed.push(path)
    },
    runGuestRecipe: async (_transport, request) => {
      recipes.push(request.parameters)
      // What the recipe leaves behind in the guest: Docker running with the toolkit and a CDI spec.
      const guest = machine.wsl.guests?.['AtomicChat']
      if (guest !== undefined) {
        guest.host = {
          ...guest.host,
          docker: { installed: true, reachable: true, service_active: true, gpu_runtime: true },
          toolkit: true,
          cdi: true,
        }
      }
      return { outcome: 'completed', log_tail: 'linux.install-container-runtime: 5 step(s) applied' }
    },
    sleep: async () => undefined,
    journal: {
      list: () => [...journal],
      remove: async (id) => {
        journal.splice(
          journal.findIndex((entry) => entry.container_id === id),
          1
        )
      },
    },
    removeEngineCaches: async (descriptorId) => {
      removed.push(`caches:${descriptorId}`)
    },
    removeModels: async (engineId) => {
      removed.push(`models:${engineId}`)
    },
    unloadEngineSessions: async (engineId) => {
      removed.push(`unload:${engineId}`)
      return { unloaded: 0 }
    },
    // Windows reaches a guest port through WSL's forwarding, unless the user's .wslconfig turned it off.
    fetch: (async (url: string | URL | Request) => {
      const port = Number(new URL(String(url)).port)
      const guest = machine.wsl.guests?.['AtomicChat']
      const forwarding = !/localhostForwarding\s*=\s*false/i.test(machine.wslconfig ?? '')
      if (forwarding && (guest?.listening ?? []).includes(port)) return new Response('ok', { status: 200 })
      throw new TypeError('fetch failed')
    }) as typeof fetch,
    keeper: {
      acquire: () => {
        leases.count += 1
        leases.peak = Math.max(leases.peak, leases.count)
        let released = false
        return {
          release: () => {
            if (released) return
            released = true
            leases.count -= 1
          },
        }
      },
      held: () => leases.count > 0,
      onStopped: () => () => undefined,
    },
    onAssessment: (view) => views.push(view),
    newId: (() => {
      let n = 0
      return () => `id-${(n += 1)}`
    })(),
    now: () => new Date('2026-10-01T00:00:00.000Z'),
  }
  return { windows, deps, views, written, downloads, removed, recipes, current: () => current, leases }
}

const signal = new AbortController().signal
const probe = async (h: Harness, request: Partial<BeginOperation> = {}) =>
  createWindowsProvisioner(h.deps).probe(record(request), signal)
const reasons = (plan: { blockers: { reason?: string }[] }) => plan.blockers.map((blocker) => blocker.reason)

describe('Windows probe — spec "Probe Windows-хоста без изменений на машине"', () => {
  it('WSL is not installed: setup-required, an elevated step that may need a restart, then import and guest setup', async () => {
    const h = harness(freshWindows())
    const { plan } = await probe(h)

    expect(plan.availability).toBe('setup-required')
    expect(plan.blockers).toEqual([])
    expect(plan.requires_elevation).toBe(true)
    expect(plan.may_require_reboot).toBe(true)
    expect(plan.may_require_relogin).toBe(false)
    expect(plan.system_changes.map((change) => change.code)).toEqual([
      'enable-wsl',
      'import-distribution',
      'provision-distribution',
    ])
    expect(plan.system_changes[1]?.params).toMatchObject({ name: 'AtomicChat', path: DISTRO_DIR })
    expect(plan.environment_manifest_id).toBe('windows-r1')
    // Place and space: the distribution's own directory and its volume (ruling core 2.1).
    expect(plan.docker_root_dir).toBe(DISTRO_DIR)
    expect(plan.free_disk_bytes).toBe(500 * GIB)
    // Read only: no distribution was imported, started or listed for change; no feature was touched.
    expect(h.windows.wslCalls).toEqual([['--version']])
    expect(h.windows.execCalls.map((call) => call[0]?.split('\\').pop())).toEqual(
      expect.arrayContaining(['nvidia-smi.exe', 'whoami.exe', 'powershell.exe'])
    )
  })

  it('virtualization is off in the firmware: blocked with the instruction, and enabling WSL is not offered', async () => {
    const h = harness({ ...freshWindows(), virtualization: { firmware: false, hypervisor: false } })
    const { plan, host_step } = await probe(h)

    expect(plan.availability).toBe('prerequisite-blocked')
    expect(reasons(plan)).toEqual(['virtualization-disabled'])
    expect(plan.blockers[0]?.message).toMatch(/BIOS|UEFI|firmware/)
    expect(plan.system_changes.map((change) => change.code)).not.toContain('enable-wsl')
    expect(plan.requires_elevation).toBe(false)
    expect(host_step).toBeNull()
  })

  it('no NVIDIA driver: blocked about the driver, no plan', async () => {
    const h = harness({ ...freshWindows(), nvidia: null })
    const { plan } = await probe(h)
    expect(plan.availability).toBe('prerequisite-blocked')
    expect(reasons(plan)).toEqual(['driver-missing'])
    expect(plan.system_changes).toEqual([])
  })

  it('a driver but no NVIDIA card: blocked about the card', async () => {
    const h = harness({ ...freshWindows(), nvidia: { driver: '591.44', gpus: [] } })
    const { plan } = await probe(h)
    expect(plan.availability).toBe('prerequisite-blocked')
    expect(reasons(plan)).toEqual(['no-gpu'])
  })

  it('Windows on ARM with only the x64 manifest: unsupported, the provider hidden', async () => {
    const h = harness({ ...freshWindows(), machine: 'arm64' })
    const { plan } = await probe(h)
    expect(plan.availability).toBe('unsupported')
    expect(reasons(plan)).toEqual(['unsupported-architecture'])
  })

  it('Windows on ARM with the arm64 manifest: the same setup an x64 PC is offered', async () => {
    const h = harness({ ...freshWindows(), machine: 'arm64' }, { manifests: manifestsOf(ARM_MANIFEST) })
    const { plan } = await probe(h)
    expect(plan.availability).toBe('setup-required')
    expect(plan.environment_manifest_id).toBe('windows-arm64-r1')
    expect(reasons(plan)).not.toContain('unsupported-architecture')
  })

  it('a build below the manifest’s minimum_windows_build: unsupported', async () => {
    const h = harness({ ...freshWindows(), release: '10.0.19045' })
    const { plan } = await probe(h)
    expect(plan.availability).toBe('unsupported')
    expect(reasons(plan)).toEqual(['windows-build-too-old'])
    expect(plan.blockers[0]?.params).toEqual({ required: '22000', actual: '19045' })
  })

  it('our own distribution is registered as WSL 1: blocked, and core does not convert it', async () => {
    const machine = importedWindows()
    machine.wsl.distributions = (machine.wsl.distributions ?? []).map((d) =>
      d.name === 'AtomicChat' ? { ...d, version: 1 } : d
    )
    const h = harness(machine, { record: RECORD })
    const { plan } = await probe(h)

    expect(plan.availability).toBe('prerequisite-blocked')
    expect(reasons(plan)).toEqual(['wsl1-distribution'])
    expect(h.windows.wslCalls.flat()).not.toContain('--set-version')
  })
})

describe('Windows probe — spec "Память и драйвер оцениваются по гостю"', () => {
  it('old libraries under a new Windows driver: blocked with both versions and the Windows driver to update', async () => {
    const h = harness(importedWindows(readyGuest({ nvml_version: '580.95.02' })), { record: RECORD })
    const { plan } = await probe(h)

    expect(plan.availability).toBe('prerequisite-blocked')
    expect(reasons(plan)).toEqual(['driver-too-old'])
    expect(plan.blockers[0]?.params).toEqual({
      required: '590.44.01',
      actual: '580.95.02',
      windows_driver: '591.44',
    })
    expect(plan.blockers[0]?.message).toMatch(/Windows/)
  })

  it('libraries at the minimum pass, even though the guest’s nvidia-smi names the Windows driver 591.44', async () => {
    const h = harness(importedWindows(), { record: RECORD })
    const { plan } = await probe(h)
    expect(plan.blockers).toEqual([])
    expect(plan.adopts_existing_engine).toBe(true)
  })

  it('the memory the check compares against is the VM’s, read from the guest’s /proc/meminfo', async () => {
    const h = harness(importedWindows(), { record: RECORD })
    await probe(h)
    expect(h.views.at(-1)?.memory_bytes).toBe(16303452 * 1024)
  })
})

describe('Windows probe — spec "Windows до публикации манифеста"', () => {
  it('no manifest and no own distribution: unsupported with MANAGED_METADATA_INVALID, the provider hidden', async () => {
    const h = harness(freshWindows(), { manifests: manifestsOf(null) })
    const { plan } = await probe(h)

    expect(plan.availability).toBe('unsupported')
    expect(plan.blockers.map((blocker) => blocker.code)).toEqual(['MANAGED_METADATA_INVALID'])
    expect(h.views.at(-1)?.availability).toBe('unsupported')
  })

  it('no manifest on the network but our distribution exists: it works by its pinned manifest, as without a network', async () => {
    const manifests = manifestsOf(null, [MANIFEST])
    const h = harness(importedWindows(), { record: RECORD, manifests })
    const { plan } = await probe(h)

    expect(plan.availability).toBe('setup-required')
    expect(plan.environment_manifest_id).toBe('windows-r1')
    expect(manifests.pinned).toHaveBeenCalledWith('windows-r1')
    expect(manifests.latest).not.toHaveBeenCalled()
  })
})

describe('Windows probe — the rest of the plan', () => {
  it('WSL already installed: no privileged step and no restart, only the import and the guest setup', async () => {
    const h = harness(wslWindows())
    const { plan, host_step } = await probe(h)

    expect(plan.availability).toBe('setup-required')
    expect(plan.requires_elevation).toBe(false)
    expect(plan.may_require_reboot).toBe(false)
    expect(host_step).toBeNull()
    expect(plan.system_changes.map((change) => change.code)).toEqual([
      'import-distribution',
      'provision-distribution',
    ])
  })

  it('a distribution with our name that this installation never recorded: blocked, and not touched', async () => {
    const h = harness(importedWindows(), { record: null })
    const { plan } = await probe(h)

    expect(plan.availability).toBe('prerequisite-blocked')
    expect(reasons(plan)).toEqual(['foreign-distribution'])
    // It was listed, never entered.
    expect(h.windows.wslCalls.some((argv) => argv[0] === '-d')).toBe(false)
  })

  it('a WSL older than minimum_wsl_version: blocked with the update command', async () => {
    const machine = wslWindows()
    machine.wsl.wsl_version = '2.3.26.0'
    const h = harness(machine)
    const { plan } = await probe(h)

    expect(plan.availability).toBe('prerequisite-blocked')
    expect(reasons(plan)).toEqual(['wsl-version'])
    expect(plan.blockers[0]?.params).toEqual({ required: '2.4.4', actual: '2.3.26' })
    expect(plan.blockers[0]?.commands).toEqual(['wsl --update'])
  })

  it('core itself running elevated: blocked — wsl.exe would register the distribution in the wrong place', async () => {
    const h = harness({ ...wslWindows(), elevated: true })
    const { plan } = await probe(h)
    expect(plan.availability).toBe('prerequisite-blocked')
    expect(reasons(plan)).toEqual(['elevated-process'])
  })

  it('a guest without Docker yet (an import that stopped short): guest setup only, no elevation', async () => {
    const guest = readyGuest()
    guest.host = {
      ...guest.host,
      docker: { installed: false, reachable: false, service_active: false, gpu_runtime: false },
      toolkit: false,
      cdi: false,
    }
    const h = harness(importedWindows(guest), { record: RECORD })
    const { plan, host_step } = await probe(h)

    expect(plan.availability).toBe('setup-required')
    expect(plan.requires_elevation).toBe(false)
    expect(host_step).toBeNull()
    expect(plan.system_changes.map((change) => change.code)).toEqual(['provision-distribution'])
  })

  it('a ready guest: adopted, nothing to change; the snapshot learns the distribution and its size', async () => {
    const h = harness(importedWindows(), { record: RECORD })
    const { plan } = await probe(h)

    expect(plan.adopts_existing_engine).toBe(true)
    expect(plan.system_changes).toEqual([])
    expect(plan.requires_elevation).toBe(false)
    // The smaller of the volume (500 GiB) and the guest's own free space (900 GiB).
    expect(plan.free_disk_bytes).toBe(500 * GIB)
    expect(h.views.at(-1)?.distribution).toEqual({
      name: 'AtomicChat',
      path: DISTRO_DIR,
      size_bytes: 30 * GIB,
    })
    expect(h.views.at(-1)?.gpus.map((gpu) => gpu.gpu_id)).toEqual([GPU])
    // Docker was asked inside the guest, as root, by its absolute path.
    expect(h.windows.wslCalls).toContainEqual(
      expect.arrayContaining(['-d', 'AtomicChat', '-u', 'root', '--exec', '/usr/bin/docker'])
    )
  })

  it('not enough space on the distribution’s volume: blocked with the path and both numbers', async () => {
    const h = harness({ ...wslWindows(), volume_free_bytes: 10 * GIB })
    const { plan } = await probe(h)
    expect(plan.availability).toBe('prerequisite-blocked')
    expect(reasons(plan)).toEqual(['insufficient-disk'])
    expect(plan.blockers[0]?.params?.['path']).toBe(DISTRO_DIR)
  })

  it('the plan digest changes with what the consent covers, and not with the free space alone', async () => {
    const a = (await probe(harness(freshWindows()))).plan.plan_digest
    const b = (await probe(harness({ ...freshWindows(), volume_free_bytes: 400 * GIB }))).plan.plan_digest
    const c = (await probe(harness(wslWindows()))).plan.plan_digest
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it('reads .wslconfig and never writes it', async () => {
    const h = harness({ ...wslWindows(), wslconfig: '[wsl2]\nlocalhostForwarding=false\nmemory=8GB\n' })
    const read = vi.spyOn(h.windows.host.probeDeps, 'readWslConfig')
    await probe(h)
    expect(read).toHaveBeenCalled()
    expect(h.windows.wslCalls.flat().join(' ')).not.toMatch(/wslconfig/i)
  })
})

describe('enabling WSL — spec "Включение WSL — единственный шаг с повышением прав"', () => {
  it('hands out windows.enable-wsl with its recipe and empty-parameters digests and a fresh nonce', async () => {
    const { host_step } = await probe(harness(freshWindows()))
    expect(host_step).toEqual({
      step_id: expect.stringMatching(/^host-step-/),
      action: 'windows.enable-wsl',
      recipe_id: ENABLE_WSL_RECIPE_ID,
      recipe_digest: ENABLE_WSL_RECIPE_DIGEST,
      parameters_digest: ENABLE_WSL_PARAMETERS_DIGEST,
      parameters: {},
      nonce: expect.any(String),
      expected_operation_revision: 0,
    })
  })

  it('verifies a receipt against the machine: not met while WSL cannot start, met once it can', async () => {
    const machine = freshWindows()
    const h = harness(machine)
    const provisioner = createWindowsProvisioner(h.deps)
    // The package is in, the VM needs the restart.
    machine.wsl = { installed: true, wsl_version: '2.4.4.0', ready: false, distributions: [], guests: {} }
    expect(await provisioner.verifyHostStep(record(), signal)).toMatchObject({
      prerequisites_met: false,
      needs_relogin: false,
    })
    machine.wsl = { ...machine.wsl, ready: true }
    expect(await provisioner.verifyHostStep(record(), signal)).toEqual({
      prerequisites_met: true,
      needs_relogin: false,
      error: null,
    })
  })

  it('needs a reboot only for an operation waiting on one, and only until WSL can start', async () => {
    const machine = freshWindows()
    machine.wsl = { installed: true, wsl_version: '2.4.4.0', ready: false, distributions: [], guests: {} }
    const provisioner = createWindowsProvisioner(harness(machine).deps)
    const waiting = record()
    waiting.machine.operation.phase = 'reboot-required'
    expect(await provisioner.inventory.needsReboot(waiting)).toBe(true)
    expect(await provisioner.inventory.needsReboot(record())).toBe(false)
    machine.wsl = { ...machine.wsl, ready: true }
    expect(await provisioner.inventory.needsReboot(waiting)).toBe(false)
  })
})

/** The operation store two cores share, in memory. */
const memoryStore = (): OperationStore => {
  const fs = new FakeManagedFs()
  let ids = 0
  return new OperationStore({
    root: '/shared',
    instanceId: 'core-1',
    newOperationId: () => 'op-1',
    newEffectId: () => `store-effect-${(ids += 1)}`,
    fs,
    now: () => fs.clock,
    sleep: async () => undefined,
    ownerIdentity: async () => ({ pid: 4242, startId: 'harness:owner' }),
  })
}

describe('UAC, a restart, and on without a new consent (state and recovery over the fake WSL)', () => {
  const serviceOn = (h: Harness, store: OperationStore, events: string[]) =>
    new EnvironmentService({
      store,
      environmentId: 'default',
      instanceId: 'core-1',
      newEffectId: (() => {
        let n = 0
        return () => `effect-${(n += 1)}`
      })(),
      provisioner: createWindowsProvisioner(h.deps),
      readSnapshot: async () => [],
      emit: (_name, payload) => events.push(payload.phase),
      identityDeps: { alive: () => false },
    })

  it('preparing-host → the app’s UAC → reboot-required → (still not restarted) reboot-required → restarted → on', async () => {
    const machine = freshWindows()
    const h = harness(machine)
    const store = memoryStore()
    const events: string[] = []
    const first = serviceOn(h, store, events)
    await first.begin('default', {
      request_id: 'req-1',
      target: TARGET,
      kind: 'setup',
      descriptor_id: DESCRIPTOR.descriptor_id,
    })
    await first.idle()
    let operation = await first.get('op-1')
    expect(operation.phase).toBe('awaiting-consent')
    await first.resume('op-1', {
      expected_revision: operation.revision,
      approved_plan_digest: operation.plan_digest!,
    })
    await first.idle()
    operation = await first.get('op-1')
    expect(operation.phase).toBe('preparing-host')
    const step = operation.pending_host_step!
    expect(step.action).toBe('windows.enable-wsl')

    // The app ran the executor through UAC: WSL is installed, and it starts only after a restart.
    machine.wsl = { installed: true, wsl_version: '2.4.4.0', ready: false, distributions: [], guests: {} }
    operation = await first.acceptHostReceipt('op-1', {
      step_id: step.step_id,
      nonce: step.nonce,
      expected_operation_revision: step.expected_operation_revision,
      recipe_digest: step.recipe_digest,
      parameters_digest: step.parameters_digest,
      outcome: 'reboot-required',
      receipt_id: 'receipt-1',
    })
    expect(operation.phase).toBe('reboot-required')
    await first.shutdown(new AbortController().signal)

    // The app opens again before the restart: still waiting, nothing asked.
    const early = serviceOn(h, store, events)
    await early.recover('core-2')
    await early.idle()
    expect((await early.get('op-1')).phase).toBe('reboot-required')
    await early.shutdown(new AbortController().signal)

    // After the restart WSL starts: the operation goes on to import, without a new consent.
    machine.wsl = { ...machine.wsl, ready: true }
    const after = serviceOn(h, store, events)
    await after.recover('core-3')
    await after.idle()
    const phasesAfterReboot = events.slice(events.lastIndexOf('reboot-required') + 1)
    expect(phasesAfterReboot).toContain('preparing-environment')
    expect(phasesAfterReboot).not.toContain('awaiting-consent')
    expect(h.windows.wslCalls.flat()).not.toContain('--install')
  })
})

/** The record an import writes, as a test expects it. */
const consented = (): PersistedOperation => {
  const base = record()
  return {
    ...base,
    machine: {
      ...base.machine,
      consented: {
        plan_digest: `sha256:${'c'.repeat(64)}`,
        descriptor_id: DESCRIPTOR.descriptor_id,
        image_digest: DESCRIPTOR.image['linux/amd64'].digest,
        environment_manifest_id: 'windows-r1',
        target: TARGET,
      },
    },
  }
}
const noOwn = async (): Promise<void> => undefined

describe('import — spec "Собственный дистрибутив импортируется от имени пользователя и только он"', () => {
  it('the user already has Ubuntu as default: a separate AtomicChat appears, Ubuntu stays default and untouched', async () => {
    const machine = wslWindows()
    machine.wsl.import_takes_default = true
    const h = harness(machine)
    await createWindowsProvisioner(h.deps).prepare(consented(), signal, noOwn)

    expect(h.downloads).toEqual([{ url: MANIFEST.rootfs.url, destination: expect.stringMatching(/\.wsl$/) }])
    const rootfs = h.downloads[0]?.destination as string
    expect(h.windows.wslCalls).toContainEqual([
      '--import',
      'AtomicChat',
      DISTRO_DIR,
      rootfs,
      '--version',
      '2',
    ])
    expect(h.removed).toContain(rootfs)
    const distributions = machine.wsl.distributions ?? []
    expect(distributions.find((d) => d.is_default)?.name).toBe('Ubuntu')
    expect(h.windows.wslCalls).toContainEqual(['--set-default', 'Ubuntu'])
    expect(h.windows.wslCalls.some((argv) => argv[0] === '-d' && argv[1] === 'Ubuntu')).toBe(false)
    expect(h.current()).toMatchObject({
      distribution: { name: 'AtomicChat', path: DISTRO_DIR },
      manifest_id: 'windows-r1',
    })
  })

  it('no default before: the import is left as the default it became, nothing else set', async () => {
    const machine = wslWindows()
    machine.wsl.distributions = []
    const h = harness(machine)
    await createWindowsProvisioner(h.deps).prepare(consented(), signal, noOwn)
    expect(h.windows.wslCalls.some((argv) => argv[0] === '--set-default')).toBe(false)
  })

  it('falls back to `wsl --install --from-file` when `--import` refuses the .wsl file (design D9)', async () => {
    const machine = wslWindows()
    machine.wsl.import_fails = ['import']
    const h = harness(machine)
    await createWindowsProvisioner(h.deps).prepare(consented(), signal, noOwn)
    const rootfs = h.downloads[0]?.destination as string
    expect(h.windows.wslCalls).toContainEqual([
      '--install',
      '--from-file',
      rootfs,
      '--name',
      'AtomicChat',
      '--location',
      DISTRO_DIR,
      '--no-launch',
    ])
    expect((machine.wsl.distributions ?? []).map((d) => d.name)).toContain('AtomicChat')
  })

  it('a tampered rootfs: the operation fails before any import, and nothing is recorded', async () => {
    const h = harness(wslWindows(), { rootfsTampered: true })
    await expect(createWindowsProvisioner(h.deps).prepare(consented(), signal, noOwn)).rejects.toMatchObject({
      code: 'MANAGED_IDENTITY_MISMATCH',
    })
    expect(h.windows.wslCalls.some((argv) => argv[0] === '--import' || argv[0] === '--install')).toBe(false)
    expect(h.current()).toBeNull()
  })

  it('a distribution with our name that we never recorded: refused, never entered, never imported over', async () => {
    const h = harness(importedWindows(), { record: null })
    await expect(createWindowsProvisioner(h.deps).prepare(consented(), signal, noOwn)).rejects.toMatchObject({
      code: 'MANAGED_PREREQUISITE_BLOCKED',
      details: 'foreign-distribution',
    })
    expect(h.windows.wslCalls.some((argv) => argv[0] === '-d' || argv[0] === '--import')).toBe(false)
  })

  it('sets the guest up: uid 1000, wsl.conf with systemd and no Windows PATH, the ownership marker, a restart', async () => {
    const machine = wslWindows()
    const h = harness(machine)
    await createWindowsProvisioner(h.deps).prepare(consented(), signal, noOwn)

    const guest = machine.wsl.guests?.['AtomicChat']
    expect(guest?.users).toEqual([{ name: 'atomic', uid: 1000 }])
    const conf = guest?.files?.['/etc/wsl.conf'] ?? ''
    expect(conf).toContain('[boot]\nsystemd=true')
    expect(conf).toContain('[user]\ndefault=atomic')
    expect(conf).toContain('[interop]\nappendWindowsPath=false')
    expect(guest?.files?.['/etc/atomic-chat/owner']).toBe(`${h.current()?.marker}\n`)
    expect(machine.wsl.terminated).toEqual(['AtomicChat'])
    // Nothing but our own distribution was ever entered, and only as root.
    for (const argv of h.windows.wslCalls.filter((call) => call[0] === '-d')) {
      expect(argv.slice(0, 4)).toEqual(['-d', 'AtomicChat', '-u', 'root'])
    }
  })
})

describe('the pinned manifest — spec "Окружение Windows закрепляет свой манифест"', () => {
  const R2: WindowsEnvironmentManifest = {
    ...MANIFEST,
    manifest_id: 'windows-r2',
    rootfs: {
      ...MANIFEST.rootfs,
      url: 'https://releases.ubuntu.com/24.04.6/ubuntu-24.04.6-wsl-amd64.wsl',
      sha256: 'a'.repeat(64),
    },
  }

  it('a new rootfs in conf changes nothing for an imported environment: no download, no import, its manifest kept', async () => {
    const manifests = manifestsOf(R2, [MANIFEST])
    const h = harness(importedWindows(), { record: RECORD, manifests })
    const provisioner = createWindowsProvisioner(h.deps)

    const { plan } = await provisioner.probe(record(), signal)
    expect(plan.environment_manifest_id).toBe('windows-r1')
    expect(plan.blockers).toEqual([])
    await provisioner.prepare(consented(), signal, noOwn)

    expect(h.downloads).toEqual([])
    expect(h.windows.wslCalls.some((argv) => argv[0] === '--import' || argv[0] === '--unregister')).toBe(
      false
    )
    expect(manifests.latest).not.toHaveBeenCalled()
  })
})

describe('the guest recipe — spec "Гость готовится тем же рецептом без повышения прав"', () => {
  it.each([
    ['an x64 PC', (): FakeWindowsMachine => wslWindows(), MANIFEST, 'x86_64', 'linux/amd64'],
    [
      'an arm64 PC',
      (): FakeWindowsMachine => {
        const machine = wslWindows()
        // The arm64 rootfs is an arm64 guest: its `uname -m` says so.
        return {
          ...machine,
          machine: 'arm64',
          wsl: {
            ...machine.wsl,
            import_guest: {
              ...machine.wsl.import_guest!,
              host: { ...machine.wsl.import_guest!.host, arch: 'aarch64' },
            },
          },
        }
      },
      ARM_MANIFEST,
      'aarch64',
      'linux/arm64',
    ],
  ] as const)(
    'a fresh distribution on %s: Docker and the toolkit by the Linux recipe for its architecture as guest root, the GPU checked, on to the pull — no relogin',
    async (_label, machineOf, manifest, arch, platform) => {
      const machine = machineOf()
      const h = harness(machine, { manifests: manifestsOf(manifest) })
      const store = memoryStore()
      const phases: string[] = []
      const service = new EnvironmentService({
        store,
        environmentId: 'default',
        instanceId: 'core-1',
        newEffectId: (() => {
          let n = 0
          return () => `effect-${(n += 1)}`
        })(),
        provisioner: createWindowsProvisioner(h.deps),
        readSnapshot: async () => [],
        emit: (_name, payload) => phases.push(payload.phase),
        identityDeps: { alive: () => false },
      })
      await service.begin('default', {
        request_id: 'req-1',
        target: TARGET,
        kind: 'setup',
        descriptor_id: DESCRIPTOR.descriptor_id,
      })
      await service.idle()
      const offered = await service.get('op-1')
      expect(offered.phase).toBe('awaiting-consent')
      await service.resume('op-1', {
        expected_revision: offered.revision,
        approved_plan_digest: offered.plan_digest!,
      })
      await service.idle()

      expect(h.recipes).toEqual([
        expect.objectContaining({
          user: 'root',
          arch,
          family: 'apt',
          distro_id: 'ubuntu',
          version_id: '24.04',
          components: expect.arrayContaining(['docker-engine', 'nvidia-container-toolkit', 'nvidia-cdi']),
        }),
      ])
      expect((h.recipes[0] as { components: string[] }).components).not.toContain('docker-group')
      // The GPU check ran in the guest on the card, after the small image came in through the Engine API.
      const runs = h.windows.wslCalls.filter((argv) => argv.includes('run') && argv.includes('--gpus'))
      expect(runs[0]).toEqual(expect.arrayContaining([`device=${GPU}`, 'nvidia-smi']))
      // The GPU-check image of the machine's own platform: an amd64 one cannot run in an arm64 guest.
      const other = platform === 'linux/arm64' ? 'linux/amd64' : 'linux/arm64'
      const mentions = (digest: string) =>
        h.windows.wslCalls.some((argv) => argv.some((arg) => arg.includes(digest)))
      expect(mentions(DESCRIPTOR.probe_image[platform].digest)).toBe(true)
      expect(mentions(DESCRIPTOR.probe_image[other].digest)).toBe(false)
      expect(h.windows.wslCalls.some((argv) => argv.includes('curl'))).toBe(true)
      expect(phases).toContain('pulling-image')
      expect(phases).not.toContain('relogin-required')
    }
  )

  it('a GPU the container cannot see: the setup fails before the engine image, naming the card', async () => {
    const machine = wslWindows()
    const guest = machine.wsl.import_guest as FakeWslGuest
    guest.host = { ...guest.host, gpu_visible_in_container: false }
    const h = harness(machine)
    await expect(createWindowsProvisioner(h.deps).prepare(consented(), signal, noOwn)).rejects.toMatchObject({
      code: 'MANAGED_PREREQUISITE_BLOCKED',
      message: expect.stringContaining('RTX 4070'),
    })
  })
})

describe('the engine image through the guest’s Engine API (design D4)', () => {
  const ENGINE = DESCRIPTOR.image['linux/amd64']
  const ENGINE_REF = `${ENGINE.repository}@${ENGINE.digest}`

  it('pulls by digest inside the guest with byte progress, verifies the digest there, and activates the installation', async () => {
    const machine = importedWindows()
    const h = harness(machine, { record: RECORD })
    const provisioner = createWindowsProvisioner(h.deps)
    const progress: { completed: number | null; total: number | null; unit: string }[] = []

    await provisioner.pull(consented(), (tick) => progress.push(tick), signal)
    expect(machine.wsl.guests?.['AtomicChat']?.host?.images).toContain(ENGINE_REF)
    expect(progress.at(-1)).toMatchObject({ unit: 'bytes', total: DESCRIPTOR.download_bytes })
    expect(progress.some((tick) => (tick.completed ?? 0) > 0)).toBe(true)
    const curl = h.windows.wslCalls.find((argv) => argv.includes('curl'))
    expect(curl?.slice(0, 5)).toEqual(['-d', 'AtomicChat', '-u', 'root', '--exec'])

    await provisioner.verify(consented(), signal)
    await provisioner.activate(consented(), signal)
    const installed = await h.deps.installations.read('tensorrt-llm')
    expect(installed?.installation.status).toBe('ready')
    expect(installed?.platform).toBe('linux/amd64')
    expect(installed?.image).toEqual(ENGINE)
  })

  it('on Windows on Arm pulls, verifies and records the arm64 engine image', async () => {
    const ARM = DESCRIPTOR.image['linux/arm64']
    const machine = { ...importedWindows(), machine: 'arm64' }
    const h = harness(machine, { record: RECORD })
    const provisioner = createWindowsProvisioner(h.deps)

    await provisioner.pull(consented(), () => undefined, signal)
    expect(machine.wsl.guests?.['AtomicChat']?.host?.images).toContain(`${ARM.repository}@${ARM.digest}`)
    expect(machine.wsl.guests?.['AtomicChat']?.host?.images).not.toContain(ENGINE_REF)

    await provisioner.verify(consented(), signal)
    await provisioner.activate(consented(), signal)
    const installed = await h.deps.installations.read('tensorrt-llm')
    expect(installed?.platform).toBe('linux/arm64')
    expect(installed?.image).toEqual(ARM)
  })

  it('a digest the guest does not hold fails verification', async () => {
    const h = harness(importedWindows(), { record: RECORD })
    await expect(createWindowsProvisioner(h.deps).verify(consented(), signal)).rejects.toMatchObject({
      code: 'MANAGED_IDENTITY_MISMATCH',
    })
  })

  it('removing the engine: loads held off and unloaded, its image and caches removed in the guest, the record gone', async () => {
    const machine = importedWindows()
    const h = harness(machine, { record: RECORD })
    const provisioner = createWindowsProvisioner(h.deps)
    await provisioner.pull(consented(), () => undefined, signal)
    await provisioner.activate(consented(), signal)

    const removal = consented()
    removal.request = { ...removal.request, kind: 'remove', retain_models: false }
    await provisioner.remove(removal, signal)

    expect(h.removed).toEqual(
      expect.arrayContaining([
        'unload:tensorrt-llm',
        `caches:${DESCRIPTOR.descriptor_id}`,
        'models:tensorrt-llm',
      ])
    )
    expect(machine.wsl.guests?.['AtomicChat']?.host?.images ?? []).not.toContain(ENGINE_REF)
    expect(await h.deps.installations.read('tensorrt-llm')).toBeNull()
    // The distribution itself stays: removing the engine is not removing the environment.
    expect((machine.wsl.distributions ?? []).map((d) => d.name)).toContain('AtomicChat')
  })
})

/**
 * A second managed engine into the same distribution (change `add-vllm-runtime`, task 2.2; spec
 * `managed-runtime-environment`, "Второй движок ставится на готовое окружение"). The second engine
 * is test data: the TensorRT-LLM fixture under another engine id and image.
 */
describe('a second managed engine on Windows', () => {
  const SECOND = parseRuntimeDescriptor({
    ...(readRuntimeFixture('tensorrt-llm-1.2.1-r2.json') as Record<string, unknown>),
    descriptor_id: 'second-engine-1.0-r1',
    engine_id: 'second-engine',
    adapter_id: 'second-engine',
    image: {
      'linux/amd64': { repository: 'docker.io/example/second-engine', digest: `sha256:${'1'.repeat(64)}` },
      'linux/arm64': { repository: 'docker.io/example/second-engine', digest: `sha256:${'2'.repeat(64)}` },
    },
  })
  const SECOND_TARGET = {
    kind: 'runtime' as const,
    installation_id: 'second-engine',
    engine_id: 'second-engine',
  }
  const byEngine: Record<string, RuntimeDescriptor> = { 'tensorrt-llm': DESCRIPTOR, 'second-engine': SECOND }
  const descriptors: RuntimeDescriptorProvider = {
    engines: [
      TENSORRT_LLM_DESCRIPTOR_SOURCE,
      { engine_id: 'second-engine', label: 'Second', url: 'https://conf/second.json' },
    ],
    forNewSetup: async (engineId) => ({
      kind: 'available',
      descriptor: byEngine[engineId] as RuntimeDescriptor,
    }),
    cachedForNewSetup: async (engineId) => ({
      kind: 'available',
      descriptor: byEngine[engineId] as RuntimeDescriptor,
    }),
    forInstallation: async (id) => {
      const found = [DESCRIPTOR, SECOND].find((descriptor) => descriptor.descriptor_id === id)
      return found === undefined
        ? { kind: 'unsupported', error: new AtomicCoreError('MANAGED_METADATA_INVALID', 'not cached') }
        : { kind: 'available', descriptor: found }
    },
  }
  const consentedSecond = (): PersistedOperation => {
    const base = record({ target: SECOND_TARGET, descriptor_id: SECOND.descriptor_id })
    return {
      ...base,
      machine: {
        ...base.machine,
        consented: {
          plan_digest: `sha256:${'c'.repeat(64)}`,
          descriptor_id: SECOND.descriptor_id,
          image_digest: SECOND.image['linux/amd64'].digest,
          environment_manifest_id: 'windows-r1',
          target: SECOND_TARGET,
        },
      },
    }
  }

  it('vLLM после TensorRT-LLM на Windows: no UAC, no restart, no import; the image goes into the same distribution and TensorRT-LLM stays ready', async () => {
    const machine = importedWindows()
    const h = harness(machine, { record: RECORD, descriptors })
    const provisioner = createWindowsProvisioner(h.deps)
    await provisioner.activate(consented(), signal)

    const { plan, host_step } = await provisioner.probe(
      record({ target: SECOND_TARGET, descriptor_id: null }),
      signal
    )
    expect(host_step).toBeNull()
    expect(plan.blockers).toEqual([])
    expect(plan.requires_elevation).toBe(false)
    expect(plan.may_require_reboot).toBe(false)
    expect(plan.system_changes).toEqual([])
    expect(plan.descriptor_id).toBe(SECOND.descriptor_id)

    const second = consentedSecond()
    await provisioner.pull(second, () => undefined, signal)
    expect(machine.wsl.guests?.['AtomicChat']?.host?.images).toContain(
      `${SECOND.image['linux/amd64'].repository}@${SECOND.image['linux/amd64'].digest}`
    )
    await provisioner.verify(second, signal)
    await provisioner.activate(second, signal)
    expect(h.downloads).toEqual([])
    expect((await h.deps.installations.read('second-engine'))?.installation.status).toBe('ready')
    expect((await h.deps.installations.read('tensorrt-llm'))?.installation.status).toBe('ready')
  })
})

describe('localhost forwarding — spec "Проброс localhost проверяется, а не предполагается"', () => {
  const installed = async (machine: FakeWindowsMachine) => {
    const h = harness(machine, { record: RECORD })
    const provisioner = createWindowsProvisioner(h.deps)
    await provisioner.pull(consented(), () => undefined, signal)
    return { h, provisioner }
  }

  it('forwarding turned off by the user: verifying fails with wsl-localhost-forwarding and the setting to restore; .wslconfig untouched', async () => {
    const machine = importedWindows()
    machine.wslconfig = '[wsl2]\nlocalhostForwarding=false\n'
    const { provisioner } = await installed(machine)
    await expect(provisioner.verify(consented(), signal)).rejects.toMatchObject({
      code: 'MANAGED_PREREQUISITE_BLOCKED',
      details: 'wsl-localhost-forwarding',
      message: expect.stringContaining('localhostForwarding=true'),
    })
    expect(machine.wslconfig).toBe('[wsl2]\nlocalhostForwarding=false\n')
  })

  it('mirrored networking with the port reachable: verifying passes as usual', async () => {
    const machine = importedWindows()
    machine.wslconfig = '[wsl2]\nnetworkingMode=mirrored\n'
    const { provisioner } = await installed(machine)
    await expect(provisioner.verify(consented(), signal)).resolves.toBeUndefined()
  })
})

describe('holding the distribution — spec "Дистрибутив удерживается, пока он нужен"', () => {
  it('holds it for each step of an operation, and lets go after', async () => {
    const h = harness(importedWindows(), { record: RECORD })
    const provisioner = createWindowsProvisioner(h.deps)
    await provisioner.prepare(consented(), signal, noOwn)
    await provisioner.pull(consented(), () => undefined, signal)
    await provisioner.verify(consented(), signal)
    expect(h.leases.peak).toBe(1)
    expect(h.leases.count).toBe(0)
  })
})

describe('removing the environment — spec "Окружение Windows удаляется целиком и только с согласием"', () => {
  const GB = 1_000_000_000
  const removal = (): PersistedOperation => {
    const base = record({ kind: 'remove', target: { kind: 'environment' } })
    return { ...base, request: { ...base.request, kind: 'remove', target: { kind: 'environment' } } }
  }
  const withModels = (): FakeWindowsMachine => {
    const guest = readyGuest()
    const scope = '/var/lib/atomic-chat/scopes'
    guest.files = {
      ...guest.files,
      [`${scope}/k1/models/tensorrt-llm/Qwen/Qwen3-32B/model.yml`]: 'x',
      [`${scope}/k2/models/tensorrt-llm/acme/m/model.yml`]: 'x',
    }
    guest.du_bytes = {
      [`${scope}/k1/models/tensorrt-llm/Qwen/Qwen3-32B`]: 30 * GB,
      [`${scope}/k2/models/tensorrt-llm/acme/m`]: 10 * GB,
    }
    return importedWindows(guest)
  }

  it('an engine still installed: refused, naming the engine to remove first; nothing unregistered', async () => {
    const h = harness(withModels(), { record: RECORD })
    await h.deps.installations.write({
      schema_version: 1,
      installation: {
        installation_id: 'tensorrt-llm',
        engine_id: 'tensorrt-llm',
        environment_id: 'default',
        active_descriptor_id: DESCRIPTOR.descriptor_id,
        candidate_descriptor_id: null,
        availability: 'supported',
        status: 'ready',
      },
      image: DESCRIPTOR.image['linux/amd64'],
      platform: 'linux/amd64',
      installed_at: '2026-10-01T00:00:00.000Z',
    })
    const provisioner = createWindowsProvisioner(h.deps)
    const { plan } = await provisioner.probe(removal(), signal)
    expect(plan.availability).toBe('prerequisite-blocked')
    expect(plan.blockers).toEqual([
      expect.objectContaining({ reason: 'engines-installed', params: { engines: 'tensorrt-llm' } }),
    ])
    await expect(provisioner.remove(removal(), signal)).rejects.toMatchObject({
      details: 'engines-installed',
    })
    expect(h.windows.wslCalls.some((argv) => argv[0] === '--unregister')).toBe(false)
  })

  it('no engine, two models of 40 GB: the plan lists them and the space; after consent the distribution and the record are gone', async () => {
    const machine = withModels()
    const h = harness(machine, { record: RECORD })
    const provisioner = createWindowsProvisioner(h.deps)

    const { plan, host_step } = await provisioner.probe(removal(), signal)
    expect(host_step).toBeNull()
    expect(plan.requires_elevation).toBe(false)
    expect(plan.blockers).toEqual([])
    const models = plan.system_changes.find((change) => change.code === 'delete-models')
    expect(models?.params).toEqual({ models: 'Qwen/Qwen3-32B,acme/m', bytes: String(40 * GB) })
    const distribution = plan.system_changes.find((change) => change.code === 'unregister-distribution')
    expect(distribution?.params).toEqual({
      name: 'AtomicChat',
      path: DISTRO_DIR,
      size_bytes: String(30 * 1024 ** 3),
    })

    await provisioner.remove(removal(), signal)
    expect(h.windows.wslCalls).toContainEqual(['--unregister', 'AtomicChat'])
    expect((machine.wsl.distributions ?? []).map((d) => d.name)).toEqual(['Ubuntu'])
    expect(h.current()).toBeNull()
    // Only ours: the user's Ubuntu was never named.
    expect(h.windows.wslCalls.some((argv) => argv.includes('Ubuntu'))).toBe(false)
  })

  it('says at once that the distribution is gone, so the app does not offer to remove it again', async () => {
    const machine = withModels()
    const h = harness(machine, { record: RECORD })
    const provisioner = createWindowsProvisioner(h.deps)
    await provisioner.remove(removal(), signal)
    expect(h.views.at(-1)).toMatchObject({ availability: 'setup-required', distribution: null })
  })

  it('after the removal the environment offers setup again', async () => {
    const machine = withModels()
    const h = harness(machine, { record: RECORD })
    const provisioner = createWindowsProvisioner(h.deps)
    await provisioner.remove(removal(), signal)
    const { plan } = await provisioner.probe(record(), signal)
    expect(plan.availability).toBe('setup-required')
    expect(plan.system_changes.map((change) => change.code)).toContain('import-distribution')
  })
})

describe('removing the environment through the service', () => {
  it('asks for consent with the plan, then removes the distribution: removed', async () => {
    const h = harness(importedWindows(), { record: RECORD })
    const service = new EnvironmentService({
      store: memoryStore(),
      environmentId: 'default',
      instanceId: 'core-1',
      newEffectId: (() => {
        let n = 0
        return () => `effect-${(n += 1)}`
      })(),
      provisioner: createWindowsProvisioner(h.deps),
      readSnapshot: async () => [],
      identityDeps: { alive: () => false },
    })
    await service.begin('default', { request_id: 'rm-1', target: { kind: 'environment' }, kind: 'remove' })
    await service.idle()
    const offered = await service.get('op-1')
    expect(offered.phase).toBe('awaiting-consent')
    await service.resume('op-1', {
      expected_revision: offered.revision,
      approved_plan_digest: offered.plan_digest!,
    })
    await service.idle()
    expect((await service.get('op-1')).phase).toBe('removed')
    expect(h.windows.wslCalls).toContainEqual(['--unregister', 'AtomicChat'])
  })
})
