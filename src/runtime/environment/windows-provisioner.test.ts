import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import type { BeginOperation, RuntimeDescriptor, WindowsEnvironmentManifest } from '../../contracts/index.js'
import {
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
import type { RuntimeDescriptorProvider } from './descriptor-provider.js'
import { parseWindowsEnvironmentManifest } from './environment-manifest.js'
import type { EnvironmentManifestProvider } from './environment-manifest-provider.js'
import { InstallationStore } from './installations.js'
import type { HostRecipeBinding, HostView } from './linux-provisioner.js'
import { startOperation } from './state.js'
import type { PersistedOperation } from './store.js'
import type { WindowsEnvironmentRecord } from './windows-environment-record.js'
import { distributionDirectory } from './windows-host.js'
import { createWindowsProvisioner, type WindowsProvisionerDeps } from './windows-provisioner.js'

const DESCRIPTOR = parseRuntimeDescriptor(readRuntimeFixture('tensorrt-llm.json')) as RuntimeDescriptor
const MANIFEST = parseWindowsEnvironmentManifest(readRuntimeFixture('environments/windows.json'))
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

/** The same machine with WSL 2.4.4 and the user's own Ubuntu as default, before Atomic Chat's import. */
const wslWindows = (): FakeWindowsMachine => ({
  ...freshWindows(),
  wsl: {
    installed: true,
    wsl_version: '2.4.4.0',
    ready: true,
    distributions: [{ name: 'Ubuntu', state: 'Stopped', version: 2, is_default: true }],
    guests: {},
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
}

const harness = (
  machine: FakeWindowsMachine,
  options: {
    record?: WindowsEnvironmentRecord | null
    manifests?: EnvironmentManifestProvider<'windows'>
  } = {}
): Harness => {
  const windows = fakeWindows(machine)
  const views: HostView[] = []
  const written: WindowsEnvironmentRecord[] = []
  let current = options.record ?? null
  const descriptors: RuntimeDescriptorProvider = {
    forNewSetup: async () => ({ kind: 'available', descriptor: DESCRIPTOR }),
    forInstallation: async (id) =>
      id === DESCRIPTOR.descriptor_id
        ? { kind: 'available', descriptor: DESCRIPTOR }
        : { kind: 'unsupported', error: new Error('not cached') as never },
    cachedForNewSetup: async () => ({ kind: 'available', descriptor: DESCRIPTOR }),
  }
  const deps: WindowsProvisionerDeps = {
    host: windows.host,
    descriptors,
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
    installations: new InstallationStore(root),
    environmentId: 'default',
    onAssessment: (view) => views.push(view),
    newId: (() => {
      let n = 0
      return () => `id-${(n += 1)}`
    })(),
    now: () => new Date('2026-10-01T00:00:00.000Z'),
  }
  return { windows, deps, views, written }
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

  it('Windows on ARM: unsupported, the provider hidden', async () => {
    const h = harness({ ...freshWindows(), machine: 'arm64' })
    const { plan } = await probe(h)
    expect(plan.availability).toBe('unsupported')
    expect(reasons(plan)).toEqual(['unsupported-architecture'])
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
