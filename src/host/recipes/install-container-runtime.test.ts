import { describe, expect, it } from 'vitest'
import { canonicalDigest } from '../../runtime/environment/index.js'
import type { LinuxInstallPlan } from '../../runtime/environment/index.js'
import {
  CONTAINER_RUNTIME_COMPONENTS,
  FORBIDDEN_WORDS,
  INSTALL_CONTAINER_RUNTIME_BINDING,
  INSTALL_CONTAINER_RUNTIME_RECIPE,
  INSTALL_CONTAINER_RUNTIME_RECIPE_DIGEST,
  INSTALL_CONTAINER_RUNTIME_RECIPE_ID,
  assertPermittedCommand,
  buildInstallContainerRuntimeSteps,
  commandsOf,
  isPackageName,
  installContainerRuntimeParametersDigest,
  parametersFromPlan,
  validateInstallContainerRuntimeParameters,
} from './install-container-runtime.js'
import type {
  ContainerRuntimeComponent,
  HostRecipeStep,
  InstallContainerRuntimeParameters,
} from './install-container-runtime.js'

const ubuntu: InstallContainerRuntimeParameters = {
  user: 'alice',
  arch: 'x86_64',
  family: 'apt',
  distro_id: 'ubuntu',
  version_id: '24.04',
  components: ['nvidia-container-toolkit'],
}
const fedora: InstallContainerRuntimeParameters = {
  ...ubuntu,
  family: 'dnf',
  distro_id: 'fedora',
  version_id: '43',
}

const build = (base: InstallContainerRuntimeParameters, components: ContainerRuntimeComponent[]) =>
  buildInstallContainerRuntimeSteps({ ...base, components })
const ids = (steps: HostRecipeStep[]) => steps.map((step) => step.id)
const step = <K extends HostRecipeStep['kind']>(steps: HostRecipeStep[], kind: K) =>
  steps.find((candidate) => candidate.kind === kind) as Extract<HostRecipeStep, { kind: K }>

describe('validating the parameters a request carries', () => {
  it.each<[string, unknown]>([
    ['an apt host', ubuntu],
    ['a dnf host', fedora],
    ['debian on arm', { ...ubuntu, distro_id: 'debian', version_id: '13', arch: 'aarch64' }],
    ['root, when no group change is asked for', { ...ubuntu, user: 'root' }],
    ['a directory-style user name', { ...ubuntu, user: 'john.doe', components: ['docker-group'] }],
  ])('accepts %s', (_name, raw) => {
    expect(validateInstallContainerRuntimeParameters(raw)).toMatchObject({ ok: true })
  })

  it.each<[string, unknown, RegExp]>([
    ['a non-object', 'alice', /object/],
    ['an array', [], /object/],
    ['an unknown key', { ...ubuntu, shell: '/bin/sh' }, /unknown parameter shell/],
    ['a missing key', { ...ubuntu, user: undefined }, /user/],
    ['root in the docker group', { ...ubuntu, user: 'root', components: ['docker-group'] }, /root/],
    ['a user name that is an option', { ...ubuntu, user: '-rf' }, /user/],
    ['a user name with a space', { ...ubuntu, user: 'a b' }, /user/],
    ['a user name that is too long', { ...ubuntu, user: 'a'.repeat(40) }, /user/],
    ['an unsupported architecture', { ...ubuntu, arch: 'i686' }, /arch/],
    ['apt on fedora', { ...fedora, family: 'apt' }, /fedora/],
    ['dnf on ubuntu', { ...ubuntu, family: 'dnf' }, /ubuntu/],
    ['an unknown ubuntu release', { ...ubuntu, version_id: '20.04' }, /20\.04/],
    ['a fedora version that is not a number', { ...fedora, version_id: 'rawhide' }, /rawhide/],
    ['an unknown distribution', { ...ubuntu, distro_id: 'arch' }, /arch/],
    // Names that exist on every object's prototype chain must not pass as distributions or releases.
    ['constructor/name on apt', { ...ubuntu, distro_id: 'constructor', version_id: 'name' }, /constructor/],
    ['__proto__/toString on apt', { ...ubuntu, distro_id: '__proto__', version_id: 'toString' }, /__proto__/],
    ['toString/length on apt', { ...ubuntu, distro_id: 'toString', version_id: 'length' }, /toString/],
    [
      'hasOwnProperty/name on apt',
      { ...ubuntu, distro_id: 'hasOwnProperty', version_id: 'name' },
      /hasOwnProperty/,
    ],
    ['constructor/name on dnf', { ...fedora, distro_id: 'constructor', version_id: 'name' }, /constructor/],
    ['__proto__/toString on dnf', { ...fedora, distro_id: '__proto__', version_id: 'toString' }, /__proto__/],
    ['ubuntu/toString', { ...ubuntu, version_id: 'toString' }, /toString/],
    ['ubuntu/__proto__', { ...ubuntu, version_id: '__proto__' }, /__proto__/],
    ['an unknown component', { ...ubuntu, components: ['docker-engine', 'kernel'] }, /kernel/],
    ['a repeated component', { ...ubuntu, components: ['docker-group', 'docker-group'] }, /repeated/],
    ['no components', { ...ubuntu, components: [] }, /nothing to do/],
    ['components that are not a list', { ...ubuntu, components: 'docker-engine' }, /components/],
  ])('refuses %s', (_name, raw, message) => {
    const result = validateInstallContainerRuntimeParameters(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.problems.join('; ')).toMatch(message)
  })

  it('puts components in recipe order, so the same set always hashes the same', () => {
    const result = validateInstallContainerRuntimeParameters({
      ...ubuntu,
      components: ['docker-group', 'docker-engine'],
    })
    expect(result).toMatchObject({ ok: true, parameters: { components: ['docker-engine', 'docker-group'] } })
  })
})

describe('the digests a request is bound to', () => {
  it('hashes the parameters canonically, independent of component order', () => {
    const a = installContainerRuntimeParametersDigest({
      ...ubuntu,
      components: ['docker-group', 'docker-engine'],
    })
    const b = installContainerRuntimeParametersDigest({
      ...ubuntu,
      components: ['docker-engine', 'docker-group'],
    })
    expect(a).toBe(b)
    expect(a).toBe(canonicalDigest({ ...ubuntu, components: ['docker-engine', 'docker-group'] }))
    expect(installContainerRuntimeParametersDigest({ ...ubuntu, user: 'bob' })).not.toBe(
      installContainerRuntimeParametersDigest(ubuntu)
    )
  })

  it('refuses to hash parameters that do not validate, as a core error', () => {
    expect(() => installContainerRuntimeParametersDigest({ ...ubuntu, arch: 'i686' as 'x86_64' })).toThrow(
      /arch/
    )
    expect(() => installContainerRuntimeParametersDigest({ ...ubuntu, arch: 'i686' as 'x86_64' })).toThrow(
      expect.objectContaining({ code: 'MANAGED_HOST_STEP_INVALID' }) as unknown as Error
    )
  })

  it('hashes the compiled recipe, and the value is pinned so no change to it goes unnoticed', () => {
    expect(INSTALL_CONTAINER_RUNTIME_RECIPE.recipe_id).toBe(INSTALL_CONTAINER_RUNTIME_RECIPE_ID)
    expect(INSTALL_CONTAINER_RUNTIME_RECIPE_DIGEST).toBe(canonicalDigest(INSTALL_CONTAINER_RUNTIME_RECIPE))
    // Changing any command, path, URL, key pin or file body changes this. Update it deliberately:
    // every client holding an old plan will then be refused, which is the point.
    expect(INSTALL_CONTAINER_RUNTIME_RECIPE_DIGEST).toMatchInlineSnapshot(
      `"sha256:137f549214074dd3b15cbd62e55c58391d9221746cc86dfbcecfcc63a6497a9d"`
    )
  })

  it('the recipe is frozen, so nothing at run time can change what the digest describes', () => {
    expect(Object.isFrozen(INSTALL_CONTAINER_RUNTIME_RECIPE)).toBe(true)
    expect(Object.isFrozen(INSTALL_CONTAINER_RUNTIME_RECIPE.apt.install)).toBe(true)
  })
})

describe('apt steps', () => {
  it('toolkit only: the NVIDIA key and list, then only the toolkit package', () => {
    const steps = build(ubuntu, ['nvidia-container-toolkit'])
    expect(ids(steps)).toEqual(['nvidia-key', 'nvidia-source', 'packages'])
    expect(steps[0]).toMatchObject({
      kind: 'install-key',
      url: 'https://nvidia.github.io/libnvidia-container/gpgkey',
      path: '/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg',
      encoding: 'binary',
      fingerprints: ['C95B321B61E88C1809C4F759DDCAE044F796ECB0'],
      mode: 0o644,
    })
    expect(steps[1]).toMatchObject({
      kind: 'write-source',
      path: '/etc/apt/sources.list.d/nvidia-container-toolkit.list',
      content:
        'deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://nvidia.github.io/libnvidia-container/stable/deb/$(ARCH) /\n',
      mode: 0o644,
    })
    const packages = step(steps, 'install-packages')
    expect(packages.packages).toEqual(['nvidia-container-toolkit'])
    expect(packages.refresh).toEqual([
      [
        'apt-get',
        'update',
        '-o',
        'Dir::Etc::sourcelist=/etc/apt/sources.list.d/nvidia-container-toolkit.list',
        '-o',
        'Dir::Etc::sourceparts=-',
        '-o',
        'APT::Get::List-Cleanup=0',
        '-o',
        'DPkg::Lock::Timeout=300',
      ],
    ])
    expect(packages.install).toEqual([
      'apt-get',
      'install',
      '-y',
      '--no-install-recommends',
      // apt's resolver may otherwise remove a conflicting package (e.g. nvidia-docker2) to satisfy
      // the install; with it, apt fails instead.
      '--no-remove',
      '-o',
      'Dpkg::Options::=--force-confdef',
      '-o',
      'Dpkg::Options::=--force-confold',
      // Wait for unattended-upgrades instead of failing on dpkg's lock.
      '-o',
      'DPkg::Lock::Timeout=300',
    ])
    expect(packages.queries).toEqual([
      {
        package: 'nvidia-container-toolkit',
        argv: ['dpkg-query', '--show', '--showformat=${Status}', 'nvidia-container-toolkit'],
      },
    ])
    expect(packages.conflicts).toEqual([])
    // apt: `--no-remove` makes apt fail rather than remove; there is no Obsoletes-style replacement.
    expect(packages.obsoletes).toBeNull()
  })

  it('docker and toolkit: both vendors, the four packages, and the Docker conflicts checked', () => {
    const steps = build(ubuntu, ['docker-engine', 'nvidia-container-toolkit'])
    expect(ids(steps)).toEqual(['docker-key', 'docker-source', 'nvidia-key', 'nvidia-source', 'packages'])
    expect(steps[0]).toMatchObject({
      url: 'https://download.docker.com/linux/ubuntu/gpg',
      path: '/etc/apt/keyrings/docker.asc',
      encoding: 'armored',
      fingerprints: ['9DC858229FC7DD38854AE2D88D81803C0EBFCD88'],
    })
    expect(steps[1]).toMatchObject({
      path: '/etc/apt/sources.list.d/docker.list',
      content:
        'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable\n',
    })
    const packages = step(steps, 'install-packages')
    expect(packages.packages).toEqual([
      'docker-ce',
      'docker-ce-cli',
      'containerd.io',
      'nvidia-container-toolkit',
    ])
    expect(packages.refresh.map((argv) => argv[3])).toEqual([
      'Dir::Etc::sourcelist=/etc/apt/sources.list.d/docker.list',
      'Dir::Etc::sourcelist=/etc/apt/sources.list.d/nvidia-container-toolkit.list',
    ])
    expect(packages.conflicts.map((c) => c.package)).toEqual([
      'docker.io',
      'podman-docker',
      'containerd',
      'runc',
    ])
  })

  it.each([
    ['ubuntu', '22.04', 'x86_64', 'amd64', 'jammy'],
    ['ubuntu', '26.04', 'aarch64', 'arm64', 'resolute'],
    ['debian', '12', 'x86_64', 'amd64', 'bookworm'],
    ['debian', '13', 'aarch64', 'arm64', 'trixie'],
  ] as const)(
    '%s %s on %s names the right suite and architecture',
    (distro, version, arch, debArch, suite) => {
      const steps = build({ ...ubuntu, distro_id: distro, version_id: version, arch }, ['docker-engine'])
      expect(step(steps, 'install-key').url).toBe(`https://download.docker.com/linux/${distro}/gpg`)
      expect(step(steps, 'write-source').content).toBe(
        `deb [arch=${debArch} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${distro} ${suite} stable\n`
      )
    }
  )

  it('runtime configuration only', () => {
    const steps = build(ubuntu, ['nvidia-runtime'])
    expect(steps).toEqual([
      {
        id: 'nvidia-runtime',
        kind: 'configure-runtime',
        daemon_json: '/etc/docker/daemon.json',
        configure: ['nvidia-ctk', 'runtime', 'configure', '--runtime=docker'],
        docker_active: ['systemctl', 'is-active', '--quiet', 'docker'],
        loaded: ['docker', 'info', '--format', '{{json .Runtimes}}'],
        restart: ['systemctl', 'restart', 'docker'],
        restart_approved: false,
      },
    ])
    expect(
      step(build(ubuntu, ['nvidia-runtime', 'docker-restart']), 'configure-runtime').restart_approved
    ).toBe(true)
  })

  it('a restart alone has nothing to restart for', () => {
    expect(build(ubuntu, ['docker-restart'])).toEqual([])
  })

  it('service only', () => {
    expect(build(ubuntu, ['docker-service'])).toEqual([
      {
        id: 'docker-service',
        kind: 'enable-service',
        enabled: ['systemctl', 'is-enabled', 'docker'],
        active: ['systemctl', 'is-active', '--quiet', 'docker'],
        enable: ['systemctl', 'enable', '--now', 'docker'],
      },
    ])
  })

  it('group only', () => {
    expect(build(ubuntu, ['docker-group'])).toEqual([
      {
        id: 'docker-group',
        kind: 'add-to-docker-group',
        user: 'alice',
        uid: ['id', '-u', 'alice'],
        groups: ['id', '-nG', 'alice'],
        add: ['usermod', '-aG', 'docker', 'alice'],
      },
    ])
  })

  it('everything, in the order the host needs it', () => {
    expect(ids(build(ubuntu, [...CONTAINER_RUNTIME_COMPONENTS]))).toEqual([
      'docker-key',
      'docker-source',
      'nvidia-key',
      'nvidia-source',
      'packages',
      'nvidia-runtime',
      'docker-service',
      'docker-group',
    ])
  })
})

describe('dnf steps', () => {
  it('toolkit only: a pinned key file and a repo file that points at it', () => {
    const steps = build(fedora, ['nvidia-container-toolkit'])
    expect(ids(steps)).toEqual(['nvidia-key', 'nvidia-source', 'packages'])
    expect(steps[0]).toMatchObject({
      url: 'https://nvidia.github.io/libnvidia-container/gpgkey',
      path: '/etc/pki/rpm-gpg/RPM-GPG-KEY-nvidia-container-toolkit',
      encoding: 'armored',
      fingerprints: ['C95B321B61E88C1809C4F759DDCAE044F796ECB0'],
    })
    expect(steps[1]).toMatchObject({
      path: '/etc/yum.repos.d/nvidia-container-toolkit.repo',
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
    })
    const packages = step(steps, 'install-packages')
    expect(packages.refresh).toEqual([])
    // No dnf option stops RPM Obsoletes (libdnf always sets SOLVER_FLAG_YUM_OBSOLETES), so the
    // install carries none; the live check below refuses instead.
    expect(packages.install).toEqual(['dnf', 'install', '-y', '--setopt=install_weak_deps=False'])
    // Live, before anything is installed, and installing or removing nothing (dnf may still refresh
    // its metadata cache): what each package to install Obsoletes in the configured repos (a repository
    // that cannot answer fails the query instead of being skipped), and whether a package of that
    // name is installed: libsolv matches Obsoletes against package names, not what they provide.
    expect(packages.obsoletes).toEqual({
      queries: [
        {
          package: 'nvidia-container-toolkit',
          argv: [
            'dnf',
            'repoquery',
            '--quiet',
            '-y',
            '--setopt=skip_if_unavailable=False',
            '--obsoletes',
            'nvidia-container-toolkit',
          ],
        },
      ],
      installed: ['rpm', '--query', '--queryformat=%{NAME}\\n'],
    })
    // Name-only, and without --quiet: rpm's own "is not installed" answer is the only "no".
    expect(packages.queries).toEqual([
      {
        package: 'nvidia-container-toolkit',
        argv: ['rpm', '--query', '--queryformat=%{NAME}\\n', 'nvidia-container-toolkit'],
      },
    ])
    // nvidia-container-toolkit Obsoletes these: checked even when Docker is not being installed.
    expect(packages.conflicts.map((c) => [c.package, c.component])).toEqual([
      ['nvidia-container-runtime', 'nvidia-container-toolkit'],
      ['nvidia-container-runtime-hook', 'nvidia-container-toolkit'],
    ])
  })

  it('docker and toolkit: Docker key pinned to the rpm fingerprint, moby-engine checked as a conflict', () => {
    const steps = build(fedora, ['docker-engine', 'nvidia-container-toolkit'])
    expect(ids(steps)).toEqual(['docker-key', 'docker-source', 'nvidia-key', 'nvidia-source', 'packages'])
    expect(steps[0]).toMatchObject({
      url: 'https://download.docker.com/linux/fedora/gpg',
      path: '/etc/pki/rpm-gpg/RPM-GPG-KEY-docker-ce',
      fingerprints: ['060A61C51B558A7F742B77AAC52FEB6B621E9F35'],
    })
    expect(steps[1]).toMatchObject({
      path: '/etc/yum.repos.d/docker-ce.repo',
      content: [
        '[docker-ce-stable]',
        'name=Docker CE Stable - $basearch',
        'baseurl=https://download.docker.com/linux/fedora/$releasever/$basearch/stable',
        'enabled=1',
        'gpgcheck=1',
        'gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-docker-ce',
        '',
      ].join('\n'),
    })
    const packages = step(steps, 'install-packages')
    expect(packages.packages).toEqual([
      'docker-ce',
      'docker-ce-cli',
      'containerd.io',
      'nvidia-container-toolkit',
    ])
    // Docker's Fedora guide has the first twelve removed first; containerd.io Obsoletes containerd
    // and runc, and older docker-ce releases Obsolete docker-ce-selinux. We refuse instead.
    expect(packages.conflicts.map((c) => c.package)).toEqual([
      'moby-engine',
      'docker',
      'docker-client',
      'docker-client-latest',
      'docker-common',
      'docker-latest',
      'docker-latest-logrotate',
      'docker-logrotate',
      'docker-selinux',
      'docker-engine-selinux',
      'docker-engine',
      'podman-docker',
      'containerd',
      'runc',
      'docker-ce-selinux',
      'nvidia-container-runtime',
      'nvidia-container-runtime-hook',
    ])
  })

  it.each<[ContainerRuntimeComponent[], string[]]>([
    [['nvidia-runtime'], ['nvidia-runtime']],
    [['docker-service'], ['docker-service']],
    [['docker-group'], ['docker-group']],
  ])('%j alone is the same single step as on apt', (components, expected) => {
    expect(ids(build(fedora, components))).toEqual(expected)
    expect(build(fedora, components)).toEqual(build(ubuntu, components))
  })
})

describe('from an install plan', () => {
  const host = {
    user: 'alice',
    arch: 'x86_64' as const,
    distro_id: 'fedora',
    version_id: '43',
    family: 'dnf' as const,
  }
  const plan = (codes: LinuxInstallPlan['system_changes']): LinuxInstallPlan => ({
    recipe_id: INSTALL_CONTAINER_RUNTIME_RECIPE_ID,
    requires_elevation: true,
    may_require_relogin: true,
    system_changes: codes,
  })

  it('moby-engine present: the plan names only the toolkit, so only the toolkit is installed', () => {
    // What `assessLinux` plans for a running moby-engine without the toolkit (spec: "Docker есть,
    // toolkit нет, работают контейнеры").
    const parameters = parametersFromPlan(
      plan([
        { code: 'add-repository', text: '', params: { vendor: 'nvidia', family: 'dnf' } },
        { code: 'install-packages', text: '', params: { packages: 'nvidia-container-toolkit' } },
        { code: 'configure-nvidia-runtime', text: '' },
        { code: 'restart-docker', text: '', params: { running_containers: '3' } },
      ]),
      host
    )
    expect(parameters.components).toEqual(['nvidia-container-toolkit', 'nvidia-runtime', 'docker-restart'])
    const steps = buildInstallContainerRuntimeSteps(parameters)
    expect(ids(steps)).toEqual(['nvidia-key', 'nvidia-source', 'packages', 'nvidia-runtime'])
    expect(step(steps, 'install-packages').packages).toEqual(['nvidia-container-toolkit'])
    // moby-engine needs Fedora's containerd and runc, so only the toolkit's obsoleted packages are checked.
    expect(step(steps, 'install-packages').conflicts.map((c) => c.package)).toEqual([
      'nvidia-container-runtime',
      'nvidia-container-runtime-hook',
    ])
    expect(step(steps, 'configure-runtime').restart_approved).toBe(true)
  })

  it('a clean host: every component, and the group for the planned user', () => {
    const parameters = parametersFromPlan(
      plan([
        { code: 'add-repository', text: '', params: { vendor: 'docker', family: 'dnf' } },
        { code: 'add-repository', text: '', params: { vendor: 'nvidia', family: 'dnf' } },
        {
          code: 'install-packages',
          text: '',
          params: { packages: 'docker-ce,docker-ce-cli,containerd.io,nvidia-container-toolkit' },
        },
        { code: 'configure-nvidia-runtime', text: '' },
        { code: 'enable-docker-service', text: '' },
        { code: 'add-user-to-docker-group', text: '', params: { user: 'alice' } },
      ]),
      host
    )
    expect(parameters).toEqual({
      ...host,
      components: [
        'docker-engine',
        'nvidia-container-toolkit',
        'nvidia-runtime',
        'docker-service',
        'docker-group',
      ],
    })
  })

  it('refuses a plan whose group line names someone other than the host user', () => {
    expect(() =>
      parametersFromPlan(
        plan([{ code: 'add-user-to-docker-group', text: '', params: { user: 'mallory' } }]),
        host
      )
    ).toThrow(/mallory/)
  })

  it('refuses with a core error, not a bare Error', () => {
    expect(() =>
      parametersFromPlan(
        plan([{ code: 'add-user-to-docker-group', text: '', params: { user: 'mallory' } }]),
        host
      )
    ).toThrow(expect.objectContaining({ code: 'MANAGED_HOST_STEP_INVALID' }) as unknown as Error)
  })

  it('refuses a plan for a different recipe, or packages outside the recipe', () => {
    expect(() => parametersFromPlan({ ...plan([]), recipe_id: 'other' }, host)).toThrow(/other/)
    expect(() =>
      parametersFromPlan(plan([{ code: 'install-packages', text: '', params: { packages: 'kernel' } }]), host)
    ).toThrow(/kernel/)
  })
})

describe('what counts as a package name', () => {
  it.each<[string, boolean]>([
    ['runc', true],
    ['nvidia-container-runtime', true],
    ['containerd.io', true],
    ['libstdc++', true],
    // Capabilities that are not names: RPM Obsoletes never match them, and rpm is never asked.
    ['config(docker-ce)', false],
    ['/usr/bin/runc', false],
    ['libc.so.6()(64bit)', false],
    ['-e', false],
    ['--all', false],
    ['a;b', false],
    ['a b', false],
    ['', false],
  ])('%j → %s', (value, expected) => {
    expect(isPackageName(value)).toBe(expected)
  })
})

describe('what the recipe may never run', () => {
  const hosts: InstallContainerRuntimeParameters[] = [
    ubuntu,
    { ...ubuntu, version_id: '22.04', arch: 'aarch64' },
    { ...ubuntu, version_id: '26.04' },
    { ...ubuntu, distro_id: 'debian', version_id: '12' },
    { ...ubuntu, distro_id: 'debian', version_id: '13', arch: 'aarch64' },
    fedora,
    { ...fedora, version_id: '44', arch: 'aarch64' },
  ]
  // Every non-empty subset of the components, on every host shape the recipe knows.
  const subsets: ContainerRuntimeComponent[][] = []
  for (let mask = 1; mask < 1 << CONTAINER_RUNTIME_COMPONENTS.length; mask++)
    subsets.push(CONTAINER_RUNTIME_COMPONENTS.filter((_, bit) => mask & (1 << bit)))

  it('no built step, in any combination, carries a word that removes or upgrades anything', () => {
    let scanned = 0
    for (const host of hosts) {
      for (const components of subsets) {
        for (const built of build(host, components)) {
          for (const argv of commandsOf(built)) {
            for (const word of argv) expect(FORBIDDEN_WORDS).not.toContain(word)
            expect(() => assertPermittedCommand(argv)).not.toThrow()
            // An update is only ever apt's index refresh, restricted to one source list.
            if (argv.includes('update')) expect(argv.slice(0, 3)).toEqual(['apt-get', 'update', '-o'])
            scanned += 1
          }
        }
      }
    }
    expect(scanned).toBeGreaterThan(1000)
  })

  it.each<[string[]]>([
    [['rm', '-f', '/etc/docker/daemon.json']],
    [['apt-get', 'purge', 'docker.io']],
    [['apt-get', 'remove', 'docker.io']],
    [['apt-get', 'autoremove']],
    [['apt-get', 'upgrade']],
    [['apt-get', 'dist-upgrade']],
    [['apt-get', 'full-upgrade']],
    [['apt-get', 'update']],
    [['apt-get', 'install', '-y', 'docker-ce']],
    [['apt-get', 'install', '-y', '--no-install-recommends', 'nvidia-container-toolkit']],
    [['dnf', 'install', '-y', '--allowerasing', 'docker-ce']],
    [['dnf', 'repoquery', '--quiet', '-y', '--setopt=skip_if_unavailable=False', '--obsoletes', 'kernel']],
    [['dnf', 'repoquery', '--installed']],
    [
      [
        'dnf',
        'repoquery',
        '--quiet',
        '-y',
        '--setopt=skip_if_unavailable=False',
        '--obsoletes',
        'docker-ce',
        'extra',
      ],
    ],
    // A repository that cannot answer must fail the query, never be skipped into an empty answer.
    [['dnf', 'repoquery', '--quiet', '-y', '--obsoletes', 'docker-ce']],
    [['dnf', 'repoquery', '--quiet', '-y', '--setopt=skip_if_unavailable=True', '--obsoletes', 'docker-ce']],
    [['dnf', 'makecache']],
    [['rpm', '--query', '-a']],
    [['rpm', '--query', '--queryformat=%{NAME}\\n', '-e']],
    [['rpm', '--query', '--queryformat=%{NAME}\\n', 'a;b']],
    [['rpm', '--query', '--queryformat=%{NAME}\\n', 'config(docker-ce)']],
    [['rpm', '--query', '--queryformat=%{NAME}\\n', 'x', 'y']],
    [['rpm', '--query', '--queryformat=%{VERSION}', 'x']],
    // Retired shapes: --whatprovides matches what a package provides, which Obsoletes never do, and
    // --quiet hides rpm's "is not installed" answer, the only one read as "no".
    [['rpm', '--query', '--whatprovides', '--queryformat=%{NAME}\\n', 'runc']],
    [['rpm', '--query', '--quiet', 'moby-engine']],
    [['constructor', 'x']],
    [['toString', 'x']],
    [['__proto__', 'x']],
    [['apt', 'install', 'x']],
    [['dnf', 'upgrade']],
    [['dnf', 'update']],
    [['dnf', 'remove', 'moby-engine']],
    [['dnf', 'erase', 'moby-engine']],
    [['rpm', '-e', 'moby-engine']],
    [['sh', '-c', 'true']],
    [['bash', '-c', 'true']],
    [['/bin/sh', 'x']],
    [['usermod', '-aG', 'docker', 'root']],
    [['usermod', '-aG', 'wheel', 'alice']],
    [['docker', 'rm', '-f', 'x']],
    [['docker', 'info']],
    [['nvidia-ctk', 'runtime', 'configure', '--runtime=docker', '--set-as-default']],
    [[]],
  ])('%j is refused', (argv) => {
    expect(() => assertPermittedCommand(argv)).toThrow(
      expect.objectContaining({ code: 'MANAGED_HOST_STEP_INVALID' }) as unknown as Error
    )
  })

  it('an apt install is only ever run with --no-remove; a dnf install never with --allowerasing, always after the live Obsoletes check', () => {
    for (const host of hosts) {
      for (const built of build(host, ['docker-engine', 'nvidia-container-toolkit'])) {
        if (built.kind !== 'install-packages') continue
        if (host.family === 'apt') expect(built.install).toContain('--no-remove')
        else {
          expect(built.install).not.toContain('--allowerasing')
          expect(built.obsoletes?.queries.map((q) => q.package)).toEqual(built.packages)
          for (const query of built.obsoletes!.queries)
            expect(query.argv).toContain('--setopt=skip_if_unavailable=False')
        }
      }
    }
  })

  it.each<[string[]]>([
    // What the dnf path runs — the install itself, and the queries before it — and nothing more is
    // needed to permit it.
    [['dnf', 'install', '-y', '--setopt=install_weak_deps=False', 'nvidia-container-toolkit']],
    [
      [
        'dnf',
        'repoquery',
        '--quiet',
        '-y',
        '--setopt=skip_if_unavailable=False',
        '--obsoletes',
        'containerd.io',
      ],
    ],
    [['rpm', '--query', '--queryformat=%{NAME}\\n', 'runc']],
    [['rpm', '--query', '--queryformat=%{NAME}\\n', 'moby-engine']],
  ])('%j is permitted', (argv) => {
    expect(() => assertPermittedCommand(argv)).not.toThrow()
  })
})

describe('INSTALL_CONTAINER_RUNTIME_BINDING (task 2.6)', () => {
  it('is this recipe: its id and digest, parameters from a plan, and their digest', () => {
    expect(INSTALL_CONTAINER_RUNTIME_BINDING.recipe_id).toBe(INSTALL_CONTAINER_RUNTIME_RECIPE_ID)
    expect(INSTALL_CONTAINER_RUNTIME_BINDING.recipe_digest).toBe(INSTALL_CONTAINER_RUNTIME_RECIPE_DIGEST)
    const parameters = INSTALL_CONTAINER_RUNTIME_BINDING.parameters(
      {
        recipe_id: INSTALL_CONTAINER_RUNTIME_RECIPE_ID,
        requires_elevation: true,
        may_require_relogin: true,
        system_changes: [{ code: 'configure-nvidia-runtime', text: 'configure' }],
      },
      { user: 'ada', arch: 'x86_64', family: 'apt', distro_id: 'ubuntu', version_id: '24.04' }
    )
    expect(parameters.components).toEqual(['nvidia-runtime'])
    expect(INSTALL_CONTAINER_RUNTIME_BINDING.parametersDigest(parameters)).toBe(
      installContainerRuntimeParametersDigest(parameters as InstallContainerRuntimeParameters)
    )
  })
})
