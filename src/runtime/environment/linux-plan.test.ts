import { describe, expect, it } from 'vitest'
import { assessLinux, compareDottedVersions, type LinuxAssessmentOptions } from './linux-plan.js'
import type { LinuxFacts } from './linux-probe.js'
import type { RecipeDistribution } from '../../contracts/index.js'

const RECIPE_DISTRIBUTIONS: RecipeDistribution[] = [
  { id: 'ubuntu', version_id: '24.04', arch: 'x86_64' },
  { id: 'ubuntu', version_id: '24.04', arch: 'aarch64' },
  { id: 'ubuntu', version_id: '26.04', arch: 'x86_64' },
  { id: 'fedora', version_id: '43', arch: 'x86_64' },
]

const OPTIONS: LinuxAssessmentOptions = {
  recipeId: 'linux.install-container-runtime',
  recipeDistributions: RECIPE_DISTRIBUTIONS,
  minimumDriverVersion: '590.44.01',
  minimumComputeCapability: '8.0',
  requiredDiskBytes: 60_000_000_000,
  currentUser: 'ana',
}

/** A fully ready Ubuntu 24.04 x86_64 host: adopts with nothing to install, unless a test overrides it. */
const facts = (over: Partial<LinuxFacts> = {}): LinuxFacts => ({
  architecture: 'x86_64',
  distribution: { id: 'ubuntu', version_id: '24.04', id_like: [], family: 'apt' },
  immutable_os: false,
  driver_version: '590.44.01',
  gpus: [
    {
      gpu_id: 'GPU-1c6a',
      name: 'NVIDIA GeForce RTX 4070',
      compute_capability: '8.9',
      total_vram_bytes: 12_282 * 1024 * 1024,
      free_vram_bytes: 11_000 * 1024 * 1024,
      driver_version: '590.44.01',
    },
  ],
  docker: {
    cli: true,
    daemon_reachable: true,
    engine_identity: 'X4RT:AAAA',
    version: '28.3.0',
    install_method: 'docker-ce',
    gpu_runtime: true,
    selinux: false,
    docker_root_dir: '/var/lib/docker',
    containers_running: 0,
  },
  toolkit_installed: true,
  free_disk_bytes: 200_000_000_000,
  unknown: [],
  ...over,
})

const changeCodes = (assessment: ReturnType<typeof assessLinux>): string[] =>
  (assessment.install_plan?.system_changes ?? []).map((change) => change.code)

describe('compareDottedVersions', () => {
  it('compares dotted versions numerically, not lexicographically', () => {
    expect(compareDottedVersions('580.65.06', '590.44.01')).toBe(-1)
    expect(compareDottedVersions('9.0', '10.0')).toBe(-1) // lexicographic would say the opposite
    expect(compareDottedVersions('8.0', '8')).toBe(0)
    expect(compareDottedVersions('8.9', '8.0')).toBe(1)
  })
})

describe('brief scenarios (task 2.4)', () => {
  it('driver 580 with a 590 minimum: blocked with both versions, before any distro or Docker question', () => {
    const assessment = assessLinux(facts({ driver_version: '580.65.06' }), OPTIONS)
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.install_plan).toBeNull()
    expect(assessment.blockers[0]?.message).toContain('580.65.06')
    expect(assessment.blockers[0]?.message).toContain('590.44.01')
    expect(assessment.blockers[0]?.details).toBe('required=590.44.01 actual=580.65.06')
  })

  it('root reaching the daemon directly adopts: access is never decided by docker-group membership', () => {
    // No `docker_group` fact exists anywhere in this module — access is `docker info` answering,
    // full stop (spec: "не членством в группе docker").
    const assessment = assessLinux(
      facts({ docker: { ...facts().docker, engine_identity: 'root-daemon' } }),
      OPTIONS
    )
    expect(assessment.availability).toBe('supported')
    expect(assessment.adopts_existing_engine).toBe(true)
    expect(assessment.blockers).toEqual([])
  })

  it('a refused socket (Docker installed, daemon not reachable by this user) plans access, not packages', () => {
    const assessment = assessLinux(
      facts({ docker: { ...facts().docker, daemon_reachable: false, gpu_runtime: false } }),
      OPTIONS
    )
    expect(assessment.availability).toBe('setup-required')
    expect(assessment.install_plan?.may_require_relogin).toBe(true)
    expect(changeCodes(assessment)).toEqual([
      'configure-nvidia-runtime',
      'enable-docker-service',
      'add-user-to-docker-group',
    ])
    // Docker and the toolkit are already installed: no packages, no repositories to add.
    expect(assessment.install_plan?.system_changes.some((c) => c.code === 'install-packages')).toBe(false)
  })

  it('Arch with a working Docker adopts exactly like any other distribution', () => {
    const assessment = assessLinux(
      facts({ distribution: { id: 'arch', version_id: 'rolling', id_like: [], family: 'pacman' } }),
      OPTIONS
    )
    expect(assessment.availability).toBe('supported')
    expect(assessment.adopts_existing_engine).toBe(true)
  })

  it('Arch without Docker is blocked with the exact pacman commands, never an automatic plan', () => {
    const assessment = assessLinux(
      facts({
        distribution: { id: 'arch', version_id: 'rolling', id_like: [], family: 'pacman' },
        docker: { ...facts().docker, daemon_reachable: false, gpu_runtime: false, install_method: null },
      }),
      OPTIONS
    )
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.install_plan).toBeNull()
    const message = assessment.blockers[0]?.message ?? ''
    expect(message).toContain('sudo pacman -S --needed docker nvidia-container-toolkit')
    expect(message).toContain('sudo nvidia-ctk runtime configure --runtime=docker')
    expect(message).toContain('sudo systemctl enable --now docker')
    expect(message).toContain('sudo usermod -aG docker $USER')
  })

  it('a clean Ubuntu 26.04 with a driver gets a full apt plan: repos, only-missing packages, group warning', () => {
    const assessment = assessLinux(
      facts({
        distribution: { id: 'ubuntu', version_id: '26.04', id_like: [], family: 'apt' },
        docker: { ...facts().docker, daemon_reachable: false, gpu_runtime: false, install_method: null },
        toolkit_installed: false,
      }),
      OPTIONS
    )
    expect(assessment.availability).toBe('setup-required')
    const plan = assessment.install_plan
    expect(plan?.requires_elevation).toBe(true)
    expect(plan?.may_require_relogin).toBe(true)
    expect(changeCodes(assessment)).toEqual([
      'add-repository',
      'add-repository',
      'install-packages',
      'configure-nvidia-runtime',
      'enable-docker-service',
      'add-user-to-docker-group',
    ])
    const packages = plan?.system_changes.find((c) => c.code === 'install-packages')
    expect(packages?.params?.packages).toBe('docker-ce,docker-ce-cli,containerd.io,nvidia-container-toolkit')
    const group = plan?.system_changes.find((c) => c.code === 'add-user-to-docker-group')
    expect(group?.text).toContain('root')
  })

  it('a clean Fedora gets a dnf plan the same shape as the apt one', () => {
    const assessment = assessLinux(
      facts({
        distribution: { id: 'fedora', version_id: '43', id_like: [], family: 'dnf' },
        docker: { ...facts().docker, daemon_reachable: false, gpu_runtime: false, install_method: null },
        toolkit_installed: false,
      }),
      OPTIONS
    )
    expect(assessment.availability).toBe('setup-required')
    expect(changeCodes(assessment)).toEqual([
      'add-repository',
      'add-repository',
      'install-packages',
      'configure-nvidia-runtime',
      'enable-docker-service',
      'add-user-to-docker-group',
    ])
    expect(assessment.install_plan?.system_changes[0]?.params?.family).toBe('dnf')
  })

  it('Fedora running moby-engine without the toolkit gets a toolkit-only plan, never docker-ce over it', () => {
    const assessment = assessLinux(
      facts({
        distribution: { id: 'fedora', version_id: '43', id_like: [], family: 'dnf' },
        docker: { ...facts().docker, install_method: 'moby-engine', gpu_runtime: false },
        toolkit_installed: false,
      }),
      OPTIONS
    )
    expect(assessment.availability).toBe('setup-required')
    expect(changeCodes(assessment)).toEqual([
      'add-repository',
      'install-packages',
      'configure-nvidia-runtime',
      'restart-docker',
    ])
    const packages = assessment.install_plan?.system_changes.find((c) => c.code === 'install-packages')
    expect(packages?.params?.packages).toBe('nvidia-container-toolkit')
    // moby-engine is already running and reachable: no group, no service-enable step.
    expect(assessment.install_plan?.may_require_relogin).toBe(false)
  })

  it('Fedora with SELinux enforcing and a working moby-engine still adopts; the flag rides along in the facts', () => {
    const built = facts({
      distribution: { id: 'fedora', version_id: '43', id_like: [], family: 'dnf' },
      docker: { ...facts().docker, install_method: 'moby-engine', selinux: true },
    })
    const assessment = assessLinux(built, OPTIONS)
    expect(assessment.availability).toBe('supported')
    expect(assessment.adopts_existing_engine).toBe(true)
    expect(built.docker.selinux).toBe(true)
  })

  it('a podman-docker shim is blocked outright: never adopted, never installed over', () => {
    const assessment = assessLinux(
      facts({ docker: { ...facts().docker, install_method: 'podman-docker' } }),
      OPTIONS
    )
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers[0]?.message).toMatch(/podman/i)
    expect(assessment.install_plan).toBeNull()
  })

  it('an immutable rpm-ostree host (Silverblue) without Docker is blocked, not offered a layering plan', () => {
    const assessment = assessLinux(
      facts({
        distribution: { id: 'fedora', version_id: '43', id_like: [], family: 'dnf' },
        immutable_os: true,
        docker: { ...facts().docker, daemon_reachable: false, gpu_runtime: false, install_method: null },
      }),
      OPTIONS
    )
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers[0]?.message).toMatch(/rpm-ostree|Silverblue/)
    expect(assessment.install_plan).toBeNull()
  })

  it('a running Docker with 3 containers and no toolkit plans a restart that says so', () => {
    const assessment = assessLinux(
      facts({
        docker: { ...facts().docker, gpu_runtime: false, containers_running: 3 },
        toolkit_installed: false,
      }),
      OPTIONS
    )
    expect(changeCodes(assessment)).toEqual([
      'add-repository',
      'install-packages',
      'configure-nvidia-runtime',
      'restart-docker',
    ])
    const restart = assessment.install_plan?.system_changes.find((c) => c.code === 'restart-docker')
    expect(restart?.text).toContain('3 running container')
    expect(restart?.params?.running_containers).toBe('3')
  })

  it('snap Docker is blocked outright, explaining why and that nothing is removed', () => {
    const assessment = assessLinux(facts({ docker: { ...facts().docker, install_method: 'snap' } }), OPTIONS)
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers[0]?.message).toMatch(/snap/i)
    expect(assessment.install_plan).toBeNull()
  })

  it('an RTX 2080 (compute capability 7.5) is blocked with the required and actual capability', () => {
    const assessment = assessLinux(
      facts({
        gpus: [
          {
            gpu_id: 'GPU-2080',
            name: 'NVIDIA GeForce RTX 2080',
            compute_capability: '7.5',
            total_vram_bytes: 8 * 1024 * 1024 * 1024,
            free_vram_bytes: 8 * 1024 * 1024 * 1024,
            driver_version: '590.44.01',
          },
        ],
      }),
      OPTIONS
    )
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers[0]?.message).toContain('8.0 or newer (Ampere+)')
    expect(assessment.blockers[0]?.message).toContain('7.5')
  })

  it('aarch64 is a supported architecture and matches the recipe like any other', () => {
    const assessment = assessLinux(
      facts({
        architecture: 'aarch64',
        docker: { ...facts().docker, daemon_reachable: false, gpu_runtime: false, install_method: null },
        toolkit_installed: false,
      }),
      OPTIONS
    )
    expect(assessment.availability).toBe('setup-required')
    expect(assessment.install_plan).not.toBeNull()
  })

  it('a GB10 with no reported memory still adopts: compute capability, not vram, decides this check', () => {
    const assessment = assessLinux(
      facts({
        gpus: [
          {
            gpu_id: 'GPU-gb10',
            name: 'NVIDIA GB10',
            compute_capability: '9.0',
            total_vram_bytes: null,
            free_vram_bytes: null,
            driver_version: '590.44.01',
          },
        ],
      }),
      OPTIONS
    )
    expect(assessment.availability).toBe('supported')
    expect(assessment.blockers).toEqual([])
  })
})

describe('other prerequisite checks', () => {
  it('blocks on a fact it could not read rather than assuming the answer it prefers', () => {
    const assessment = assessLinux(facts({ unknown: ['architecture'] }), OPTIONS)
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers[0]?.details).toBe('architecture')
  })

  it('reports a missing driver as something the user installs, not something setup can fix', () => {
    const assessment = assessLinux(facts({ driver_version: null, gpus: [] }), OPTIONS)
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers.some((b) => b.message.includes('NVIDIA driver'))).toBe(true)
  })

  it('reports a driver that sees no card, which no install will change either', () => {
    const assessment = assessLinux(facts({ gpus: [] }), OPTIONS)
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers.some((b) => b.message.includes('no usable GPU'))).toBe(true)
  })

  it('rejects an unsupported architecture outright', () => {
    const assessment = assessLinux(facts({ architecture: 'armv7l' }), OPTIONS)
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers[0]?.message).toContain('armv7l')
  })

  it('will not offer a one-click install on a distribution nobody has qualified', () => {
    const assessment = assessLinux(
      facts({
        distribution: { id: 'opensuse-tumbleweed', version_id: '20250101', id_like: [], family: 'other' },
        docker: { ...facts().docker, daemon_reachable: false, gpu_runtime: false, install_method: null },
      }),
      OPTIONS
    )
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers[0]?.details).toContain('opensuse-tumbleweed')
    expect(assessment.install_plan).toBeNull()
  })

  it('refuses when the image would not fit, and says by how much, even on an otherwise-ready host', () => {
    const assessment = assessLinux(facts({ free_disk_bytes: 10_000_000_000 }), OPTIONS)
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers[0]?.details).toContain('required=60000000000')
  })

  it('blocks a rootless or Docker Desktop install the same way as snap and podman', () => {
    expect(
      assessLinux(facts({ docker: { ...facts().docker, install_method: 'rootless' } }), OPTIONS).blockers[0]
        ?.message
    ).toMatch(/rootless/i)
    expect(
      assessLinux(facts({ docker: { ...facts().docker, install_method: 'docker-desktop' } }), OPTIONS)
        .blockers[0]?.message
    ).toMatch(/Docker Desktop/i)
  })
})
