/**
 * The `linux.install-container-runtime` recipe (design D2/D3): Docker Engine and the NVIDIA
 * Container Toolkit from the vendors' own apt or dnf repositories, the NVIDIA runtime registered
 * with Docker, `docker.service` enabled, and the user added to the `docker` group. This is the one
 * piece of code in the product that runs as root on a user's machine, so its shape is deliberate:
 *
 * - **Data in, argv out.** `buildInstallContainerRuntimeSteps` is pure. Every command is an argv
 *   array taken from `INSTALL_CONTAINER_RUNTIME_RECIPE` with validated values substituted into whole
 *   arguments; nothing is ever handed to a shell.
 * - **The recipe is its own digest.** Every command, path, URL, key fingerprint and file body lives
 *   in the frozen `INSTALL_CONTAINER_RUNTIME_RECIPE`, and `INSTALL_CONTAINER_RUNTIME_RECIPE_DIGEST`
 *   is its canonical hash. A change to any of them changes the digest, which a test pins.
 * - **Only what is missing.** Parameters name components, never packages or commands. The executor
 *   re-checks each one on the machine and skips what is already there, so a replay is a no-op.
 * - **Nothing removed, nothing upgraded.** No step removes a package or a file, or upgrades the
 *   system. `assertPermittedCommand` is an allowlist the executor applies to every argv before it
 *   runs, and a test scans every step this module can build for the forbidden words.
 */

import type { Sha256Digest } from '../../contracts/index.js'
import { canonicalDigest } from '../../runtime/environment/index.js'
import type { LinuxInstallPlan } from '../../runtime/environment/index.js'

export const INSTALL_CONTAINER_RUNTIME_RECIPE_ID = 'linux.install-container-runtime'

/**
 * What a plan can ask the recipe for, in the order the recipe applies them. `docker-restart` is not
 * a step of its own: it is the user's consent (design D5) to restart a Docker that was already
 * running when `nvidia-runtime` changes its configuration.
 */
export const CONTAINER_RUNTIME_COMPONENTS = [
  'docker-engine',
  'nvidia-container-toolkit',
  'nvidia-runtime',
  'docker-restart',
  'docker-service',
  'docker-group',
] as const
export type ContainerRuntimeComponent = (typeof CONTAINER_RUNTIME_COMPONENTS)[number]

/** Every value the privileged step takes from outside. Nothing else reaches it. */
export interface InstallContainerRuntimeParameters {
  /** The account to add to the `docker` group. Never `root` when `docker-group` is asked for. */
  user: string
  arch: 'x86_64' | 'aarch64'
  family: 'apt' | 'dnf'
  distro_id: string
  version_id: string
  components: ContainerRuntimeComponent[]
}

/** Deep-freezes the recipe so the object the digest describes is the object that runs. */
function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child)
    Object.freeze(value)
  }
  return value
}

/**
 * Key fingerprints, pinned. Docker's rpm key is the one Docker's Fedora install guide tells the
 * user to verify. Docker's deb key and NVIDIA's key are not printed in the vendors' current guides;
 * these are the primary-key fingerprints of the keys the guides' URLs served on 2026-09-28, as
 * `gpg --show-keys` reports them (`test/fixtures/host-keys/`). Docker's deb key is also the value
 * Docker's Debian/Ubuntu guides printed for years ("9DC8 5822 9FC7 DD38 854A E2D8 8D81 803C 0EBF CD88").
 */
const DOCKER_DEB_KEY = '9DC858229FC7DD38854AE2D88D81803C0EBFCD88'
const DOCKER_RPM_KEY = '060A61C51B558A7F742B77AAC52FEB6B621E9F35'
const NVIDIA_KEY = 'C95B321B61E88C1809C4F759DDCAE044F796ECB0'

const DOCKER_ACTIVE = ['systemctl', 'is-active', '--quiet', 'docker']

/**
 * The whole recipe as data. `{{name}}` marks a whole-argument or in-file substitution of a
 * validated parameter; there is no other kind of template.
 */
export const INSTALL_CONTAINER_RUNTIME_RECIPE = frozen({
  recipe_id: INSTALL_CONTAINER_RUNTIME_RECIPE_ID,
  revision: 1,
  /**
   * The environment every command runs with, instead of the caller's. `sudo` and `pkexec` already
   * scrub most of it, but a variable like `APT_CONFIG` or `LD_PRELOAD` must never reach a root
   * package manager, whoever started us.
   */
  environment: {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    DEBIAN_FRONTEND: 'noninteractive',
  },
  packages: {
    'docker-engine': ['docker-ce', 'docker-ce-cli', 'containerd.io'],
    'nvidia-container-toolkit': ['nvidia-container-toolkit'],
  },
  apt: {
    /** Release → suite. Only these releases are buildable; `VERSION_CODENAME` is never trusted. */
    suites: {
      ubuntu: { '22.04': 'jammy', '24.04': 'noble', '26.04': 'resolute' },
      debian: { '12': 'bookworm', '13': 'trixie' },
    } as Record<string, Record<string, string>>,
    architectures: { x86_64: 'amd64', aarch64: 'arm64' },
    repositories: {
      'docker-engine': {
        key: {
          url: 'https://download.docker.com/linux/{{distro}}/gpg',
          path: '/etc/apt/keyrings/docker.asc',
          encoding: 'armored',
          fingerprints: [DOCKER_DEB_KEY],
        },
        source: {
          path: '/etc/apt/sources.list.d/docker.list',
          content:
            'deb [arch={{deb_arch}} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/{{distro}} {{suite}} stable\n',
        },
      },
      'nvidia-container-toolkit': {
        key: {
          url: 'https://nvidia.github.io/libnvidia-container/gpgkey',
          path: '/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg',
          encoding: 'binary',
          fingerprints: [NVIDIA_KEY],
        },
        source: {
          path: '/etc/apt/sources.list.d/nvidia-container-toolkit.list',
          content:
            'deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://nvidia.github.io/libnvidia-container/stable/deb/$(ARCH) /\n',
        },
      },
    },
    /** Refresh one source list only: no other repository is fetched, no list is cleaned up. */
    refresh: [
      'apt-get',
      'update',
      '-o',
      'Dir::Etc::sourcelist={{source}}',
      '-o',
      'Dir::Etc::sourceparts=-',
      '-o',
      'APT::Get::List-Cleanup=0',
    ],
    installed: ['dpkg-query', '--show', '--showformat=${Status}', '{{package}}'],
    /** Missing packages are appended. `confold` keeps the user's config on a dependency's upgrade. */
    install: [
      'apt-get',
      'install',
      '-y',
      '--no-install-recommends',
      '-o',
      'Dpkg::Options::=--force-confdef',
      '-o',
      'Dpkg::Options::=--force-confold',
    ],
    /** Docker's guide has these removed first. We never remove anything, so we refuse instead. */
    conflicts: ['docker.io', 'podman-docker', 'containerd', 'runc'],
  },
  dnf: {
    /** Fedora's `VERSION_ID` is a plain release number; the descriptor decides which ones qualify. */
    versions: { fedora: '^[1-9][0-9]$' } as Record<string, string>,
    repositories: {
      'docker-engine': {
        key: {
          url: 'https://download.docker.com/linux/fedora/gpg',
          path: '/etc/pki/rpm-gpg/RPM-GPG-KEY-docker-ce',
          encoding: 'armored',
          fingerprints: [DOCKER_RPM_KEY],
        },
        source: {
          path: '/etc/yum.repos.d/docker-ce.repo',
          // Docker's own `docker-ce.repo`, stable channel only, with the key we pinned instead of
          // a URL dnf would import from without asking anyone.
          content: [
            '[docker-ce-stable]',
            'name=Docker CE Stable - $basearch',
            'baseurl=https://download.docker.com/linux/fedora/$releasever/$basearch/stable',
            'enabled=1',
            'gpgcheck=1',
            'gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-docker-ce',
            '',
          ].join('\n'),
        },
      },
      'nvidia-container-toolkit': {
        key: {
          url: 'https://nvidia.github.io/libnvidia-container/gpgkey',
          path: '/etc/pki/rpm-gpg/RPM-GPG-KEY-nvidia-container-toolkit',
          encoding: 'armored',
          fingerprints: [NVIDIA_KEY],
        },
        source: {
          path: '/etc/yum.repos.d/nvidia-container-toolkit.repo',
          // NVIDIA's `nvidia-container-toolkit.repo`, stable channel only, same substitution.
          content: [
            '[nvidia-container-toolkit]',
            'name=nvidia-container-toolkit',
            'baseurl=https://nvidia.github.io/libnvidia-container/stable/rpm/$basearch',
            'repo_gpgcheck=1',
            'gpgcheck=0',
            'enabled=1',
            'gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-nvidia-container-toolkit',
            '',
          ].join('\n'),
        },
      },
    },
    installed: ['rpm', '--query', '--quiet', '{{package}}'],
    install: ['dnf', 'install', '-y', '--setopt=install_weak_deps=False'],
    conflicts: ['moby-engine', 'docker', 'podman-docker'],
  },
  file_mode: 0o644,
  runtime: {
    daemon_json: '/etc/docker/daemon.json',
    configure: ['nvidia-ctk', 'runtime', 'configure', '--runtime=docker'],
    docker_active: DOCKER_ACTIVE,
    /** Which runtimes the running daemon actually loaded, as opposed to what daemon.json says. */
    loaded: ['docker', 'info', '--format', '{{json .Runtimes}}'],
    restart: ['systemctl', 'restart', 'docker'],
  },
  service: {
    enabled: ['systemctl', 'is-enabled', 'docker'],
    active: DOCKER_ACTIVE,
    enable: ['systemctl', 'enable', '--now', 'docker'],
  },
  group: {
    uid: ['id', '-u', '{{user}}'],
    groups: ['id', '-nG', '{{user}}'],
    add: ['usermod', '-aG', 'docker', '{{user}}'],
  },
})

export const INSTALL_CONTAINER_RUNTIME_RECIPE_DIGEST: Sha256Digest = canonicalDigest(
  INSTALL_CONTAINER_RUNTIME_RECIPE
)

// ---------------------------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------------------------

/** POSIX portable user name; a leading `-` would be read as an option. */
const USER_NAME = /^[A-Za-z_][A-Za-z0-9._-]{0,31}$/
const PARAMETER_KEYS = ['user', 'arch', 'family', 'distro_id', 'version_id', 'components'] as const

export type ParametersValidation =
  { ok: true; parameters: InstallContainerRuntimeParameters } | { ok: false; problems: string[] }

function familyOf(distro: string): 'apt' | 'dnf' | null {
  if (distro in INSTALL_CONTAINER_RUNTIME_RECIPE.apt.suites) return 'apt'
  if (distro in INSTALL_CONTAINER_RUNTIME_RECIPE.dnf.versions) return 'dnf'
  return null
}

/**
 * Checks untrusted parameters against what this recipe can build, and returns them normalised
 * (components in recipe order). The descriptor's distribution list is the core's business; this
 * only refuses what the compiled recipe has no commands for.
 */
export function validateInstallContainerRuntimeParameters(raw: unknown): ParametersValidation {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    return { ok: false, problems: ['parameters must be an object'] }
  const input = raw as Record<string, unknown>
  const problems: string[] = []
  for (const key of Object.keys(input))
    if (!(PARAMETER_KEYS as readonly string[]).includes(key)) problems.push(`unknown parameter ${key}`)

  const { user, arch, family, distro_id: distro, version_id: version, components } = input
  if (typeof user !== 'string' || !USER_NAME.test(user)) problems.push('user must be a POSIX user name')
  if (arch !== 'x86_64' && arch !== 'aarch64') problems.push('arch must be x86_64 or aarch64')
  if (family !== 'apt' && family !== 'dnf') problems.push('family must be apt or dnf')
  if (typeof distro !== 'string' || typeof version !== 'string') {
    problems.push('distro_id and version_id must be strings')
  } else {
    const expected = familyOf(distro)
    if (expected === null) problems.push(`the recipe has no commands for distribution ${distro}`)
    else if (expected !== family) problems.push(`${distro} uses ${expected}, not ${String(family)}`)
    else if (
      expected === 'apt' &&
      INSTALL_CONTAINER_RUNTIME_RECIPE.apt.suites[distro]?.[version] === undefined
    )
      problems.push(`the recipe has no apt suite for ${distro} ${version}`)
    else if (
      expected === 'dnf' &&
      !new RegExp(INSTALL_CONTAINER_RUNTIME_RECIPE.dnf.versions[distro]!).test(version)
    )
      problems.push(`${version} is not a ${distro} release number`)
  }

  let ordered: ContainerRuntimeComponent[] = []
  if (!Array.isArray(components)) {
    problems.push('components must be a list')
  } else {
    for (const component of components)
      if (!(CONTAINER_RUNTIME_COMPONENTS as readonly unknown[]).includes(component))
        problems.push(`unknown component ${String(component)}`)
    if (new Set(components).size !== components.length) problems.push('a component is repeated')
    if (components.length === 0) problems.push('components is empty: nothing to do')
    ordered = CONTAINER_RUNTIME_COMPONENTS.filter((component) => components.includes(component))
  }
  // Root needs no group (design D4); adding it would only ever be a mistake or an attack.
  if (user === 'root' && ordered.includes('docker-group'))
    problems.push('root is never added to the docker group')

  if (problems.length > 0) return { ok: false, problems }
  return {
    ok: true,
    parameters: {
      user: user as string,
      arch: arch as 'x86_64' | 'aarch64',
      family: family as 'apt' | 'dnf',
      distro_id: distro as string,
      version_id: version as string,
      components: ordered,
    },
  }
}

function validated(parameters: InstallContainerRuntimeParameters): InstallContainerRuntimeParameters {
  const result = validateInstallContainerRuntimeParameters(parameters)
  if (!result.ok) throw new Error(`invalid recipe parameters: ${result.problems.join('; ')}`)
  return result.parameters
}

/** Canonical-JSON sha256 of the normalised parameters: what `parameters_digest` must equal. */
export function installContainerRuntimeParametersDigest(
  parameters: InstallContainerRuntimeParameters
): Sha256Digest {
  return canonicalDigest(validated(parameters))
}

/**
 * The parameters for an install plan from `assessLinux` (task 2.4), for the core to put behind a
 * `pending_host_step` (task 2.6). Each system change maps to one component; anything the recipe
 * cannot do, or a group line for an account other than the host's user, is refused.
 */
export function parametersFromPlan(
  plan: LinuxInstallPlan,
  host: Omit<InstallContainerRuntimeParameters, 'components'>
): InstallContainerRuntimeParameters {
  if (plan.recipe_id !== INSTALL_CONTAINER_RUNTIME_RECIPE_ID)
    throw new Error(`the plan is for recipe ${plan.recipe_id}, not ${INSTALL_CONTAINER_RUNTIME_RECIPE_ID}`)
  const wanted = new Set<ContainerRuntimeComponent>()
  const { packages } = INSTALL_CONTAINER_RUNTIME_RECIPE
  for (const change of plan.system_changes) {
    switch (change.code) {
      case 'add-repository':
        wanted.add(change.params?.['vendor'] === 'docker' ? 'docker-engine' : 'nvidia-container-toolkit')
        break
      case 'install-packages':
        for (const name of (change.params?.['packages'] ?? '').split(',').filter(Boolean)) {
          if (packages['docker-engine'].includes(name)) wanted.add('docker-engine')
          else if (packages['nvidia-container-toolkit'].includes(name)) wanted.add('nvidia-container-toolkit')
          else throw new Error(`the recipe does not install package ${name}`)
        }
        break
      case 'configure-nvidia-runtime':
        wanted.add('nvidia-runtime')
        break
      case 'restart-docker':
        wanted.add('docker-restart')
        break
      case 'enable-docker-service':
        wanted.add('docker-service')
        break
      case 'add-user-to-docker-group':
        if (change.params?.['user'] !== host.user)
          throw new Error(
            `the plan adds ${String(change.params?.['user'])} to the docker group, not ${host.user}`
          )
        wanted.add('docker-group')
        break
    }
  }
  return validated({ ...host, components: [...wanted] })
}

// ---------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------

/**
 * One unit of work, with everything the executor needs to decide whether it is already done and,
 * if not, to do it. Every command in it is already a complete argv.
 */
export type HostRecipeStep =
  | {
      id: string
      kind: 'install-key'
      url: string
      path: string
      /** `armored` writes the text as served; `binary` writes the dearmored key (apt `.gpg`). */
      encoding: 'armored' | 'binary'
      fingerprints: string[]
      mode: number
    }
  | { id: string; kind: 'write-source'; path: string; content: string; mode: number }
  | {
      id: string
      kind: 'install-packages'
      packages: string[]
      queries: { package: string; argv: string[] }[]
      /** Installed packages that make installing Docker's unsafe. Empty unless Docker is asked for. */
      conflicts: { package: string; argv: string[] }[]
      refresh: string[][]
      /** Without package names: the executor appends only the ones still missing. */
      install: string[]
    }
  | {
      id: string
      kind: 'configure-runtime'
      daemon_json: string
      configure: string[]
      docker_active: string[]
      loaded: string[]
      restart: string[]
      /** The plan listed the restart and the user consented to it (design D5). */
      restart_approved: boolean
    }
  | { id: string; kind: 'enable-service'; enabled: string[]; active: string[]; enable: string[] }
  | { id: string; kind: 'add-to-docker-group'; user: string; uid: string[]; groups: string[]; add: string[] }

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([a-z_]+)\}\}/g, (_match, name: string) => {
    const value = values[name]
    if (value === undefined) throw new Error(`no value for {{${name}}}`)
    return value
  })
}

const argv = (template: readonly string[], values: Record<string, string>): string[] =>
  template.map((part) => fill(part, values))

const VENDOR_IDS: Record<'docker-engine' | 'nvidia-container-toolkit', string> = {
  'docker-engine': 'docker',
  'nvidia-container-toolkit': 'nvidia',
}

/** The ordered steps for these parameters. Throws on parameters that do not validate. */
export function buildInstallContainerRuntimeSteps(
  input: InstallContainerRuntimeParameters
): HostRecipeStep[] {
  const parameters = validated(input)
  const recipe = INSTALL_CONTAINER_RUNTIME_RECIPE
  const wants = (component: ContainerRuntimeComponent): boolean => parameters.components.includes(component)
  const family = recipe[parameters.family]
  const values: Record<string, string> = {
    distro: parameters.distro_id,
    user: parameters.user,
    deb_arch: recipe.apt.architectures[parameters.arch],
    suite: recipe.apt.suites[parameters.distro_id]?.[parameters.version_id] ?? '',
  }
  const steps: HostRecipeStep[] = []

  const vendors = (['docker-engine', 'nvidia-container-toolkit'] as const).filter(wants)
  for (const vendor of vendors) {
    const { key, source } = family.repositories[vendor]
    steps.push({
      id: `${VENDOR_IDS[vendor]}-key`,
      kind: 'install-key',
      url: fill(key.url, values),
      path: key.path,
      encoding: key.encoding as 'armored' | 'binary',
      fingerprints: [...key.fingerprints],
      mode: recipe.file_mode,
    })
    steps.push({
      id: `${VENDOR_IDS[vendor]}-source`,
      kind: 'write-source',
      path: source.path,
      content: fill(source.content, values),
      mode: recipe.file_mode,
    })
  }

  if (vendors.length > 0) {
    const packages = vendors.flatMap((vendor) => recipe.packages[vendor])
    const query = (name: string) => ({ package: name, argv: argv(family.installed, { package: name }) })
    steps.push({
      id: 'packages',
      kind: 'install-packages',
      packages,
      queries: packages.map(query),
      conflicts: wants('docker-engine') ? family.conflicts.map(query) : [],
      refresh:
        parameters.family === 'apt'
          ? vendors.map((vendor) =>
              argv(recipe.apt.refresh, { source: recipe.apt.repositories[vendor].source.path })
            )
          : [],
      install: [...family.install],
    })
  }

  if (wants('nvidia-runtime')) {
    steps.push({
      id: 'nvidia-runtime',
      kind: 'configure-runtime',
      daemon_json: recipe.runtime.daemon_json,
      configure: [...recipe.runtime.configure],
      docker_active: [...recipe.runtime.docker_active],
      loaded: [...recipe.runtime.loaded],
      restart: [...recipe.runtime.restart],
      restart_approved: wants('docker-restart'),
    })
  }

  if (wants('docker-service')) {
    steps.push({
      id: 'docker-service',
      kind: 'enable-service',
      enabled: [...recipe.service.enabled],
      active: [...recipe.service.active],
      enable: [...recipe.service.enable],
    })
  }

  if (wants('docker-group')) {
    steps.push({
      id: 'docker-group',
      kind: 'add-to-docker-group',
      user: parameters.user,
      uid: argv(recipe.group.uid, values),
      groups: argv(recipe.group.groups, values),
      add: argv(recipe.group.add, values),
    })
  }

  return steps
}

/** Every argv a step can run, checks included — what the forbidden-word scan reads. */
export function commandsOf(step: HostRecipeStep): string[][] {
  switch (step.kind) {
    case 'install-key':
    case 'write-source':
      return []
    case 'install-packages':
      return [
        ...step.queries.map((query) => query.argv),
        ...step.conflicts.map((conflict) => conflict.argv),
        ...step.refresh,
        [...step.install, ...step.packages],
      ]
    case 'configure-runtime':
      return [step.configure, step.docker_active, step.loaded, step.restart]
    case 'enable-service':
      return [step.enabled, step.active, step.enable]
    case 'add-to-docker-group':
      return [step.uid, step.groups, step.add]
  }
}

// ---------------------------------------------------------------------------------------------
// The allowlist every command passes before it runs
// ---------------------------------------------------------------------------------------------

/** Words that remove or upgrade. None may appear in any argument of any command. */
export const FORBIDDEN_WORDS: readonly string[] = [
  'rm',
  'purge',
  'remove',
  'autoremove',
  'erase',
  'upgrade',
  'dist-upgrade',
  'full-upgrade',
  'distro-sync',
  'reinstall',
  'downgrade',
  '-e',
  '--erase',
]

/** Program → the first argument it may be run with. Nothing else is ever run as root. */
const PERMITTED: Record<string, readonly string[]> = {
  'apt-get': ['install', 'update'],
  'dpkg-query': ['--show'],
  'dnf': ['install'],
  'rpm': ['--query'],
  'nvidia-ctk': ['runtime'],
  'systemctl': ['is-active', 'is-enabled', 'enable', 'restart'],
  'id': ['-u', '-nG'],
  'docker': ['info'],
  'usermod': ['-aG'],
}

/**
 * Throws unless `argv` is one of the command shapes this recipe runs. The executor calls it on
 * every command, so even a bug in step building cannot reach a shell, a removal or an upgrade.
 */
export function assertPermittedCommand(argv: readonly string[]): void {
  const [program, first] = argv
  const refuse = (why: string): never => {
    throw new Error(`refusing to run ${JSON.stringify(argv)}: ${why}`)
  }
  if (program === undefined) refuse('empty command')
  const allowed = PERMITTED[program as string]
  if (allowed === undefined) refuse(`${String(program)} is not a program this recipe runs`)
  if (first === undefined || !allowed!.includes(first)) refuse(`${String(first)} is not permitted here`)
  for (const word of argv) if (FORBIDDEN_WORDS.includes(word)) refuse(`${word} is forbidden`)
  // An index refresh is only ever of one explicit source list, never of the whole system.
  if (program === 'apt-get' && first === 'update' && !argv.includes('Dir::Etc::sourceparts=-'))
    refuse('apt-get update must be restricted to one source list')
  if (program === 'usermod' && (argv[2] !== 'docker' || argv.length !== 4 || argv[3] === 'root'))
    refuse('usermod only ever adds a non-root user to docker')
  if (program === 'docker' && argv.join(' ') !== 'docker info --format {{json .Runtimes}}')
    refuse('docker is only ever asked which runtimes it loaded')
  if (program === 'nvidia-ctk' && argv.join(' ') !== 'nvidia-ctk runtime configure --runtime=docker')
    refuse('nvidia-ctk only ever configures the docker runtime')
}
