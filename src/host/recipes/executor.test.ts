import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import { executeHostStep } from './executor.js'
import type { HostStepExecutorDeps } from './executor.js'
import {
  INSTALL_CONTAINER_RUNTIME_RECIPE_DIGEST,
  installContainerRuntimeParametersDigest,
} from './install-container-runtime.js'
import type {
  ContainerRuntimeComponent,
  InstallContainerRuntimeParameters,
} from './install-container-runtime.js'
import type { HostStepResult } from './request-file.js'

const keys = join(process.cwd(), 'test/fixtures/host-keys')
const KEY_TEXT: Record<string, string> = {
  'https://download.docker.com/linux/ubuntu/gpg': readFileSync(join(keys, 'docker-deb.asc'), 'utf8'),
  'https://download.docker.com/linux/fedora/gpg': readFileSync(join(keys, 'docker-rpm.asc'), 'utf8'),
  'https://nvidia.github.io/libnvidia-container/gpgkey': readFileSync(
    join(keys, 'nvidia-container-toolkit.asc'),
    'utf8'
  ),
}

const DOCKER = ['docker-ce', 'docker-ce-cli', 'containerd.io']
const REQUEST = '/home/alice/.local/share/atomic/host-steps/step-1.request.json'
const RESULT = '/home/alice/.local/share/atomic/host-steps/step-1.result.json'

/**
 * A pretend Linux machine: what is installed, which files exist, whether Docker runs and with which
 * runtimes, who is in which group. Commands the recipe runs change it the way the real ones would;
 * a command it does not model fails the test.
 */
class FakeHost {
  packages = new Set<string>()
  files = new Map<string, { data: Uint8Array; mode: number }>()
  dockerActive = false
  dockerEnabled = false
  loadedRuntimes: string[] = ['runc']
  users: Record<string, { uid: string; groups: string[] }> = {
    alice: { uid: '1000', groups: ['alice', 'sudo'] },
    toor: { uid: '0', groups: ['root'] },
  }
  /** apt's docker-ce postinst starts the daemon; Fedora's does not. */
  startsOnInstall = true
  /** `nvidia-ctk` writes the file; set to false to model it leaving the file untouched. */
  ctkWrites = true
  /** Command-line prefix → the answer every command starting with it gets instead. */
  failures: Record<string, { code: number | null; stdout?: string; stderr: string }> = {}
  calls: string[][] = []
  fetched: string[] = []
  invokingUid: string | null = '1000'

  /** What `dnf repoquery --obsoletes <pkg>` prints for each package, one capability per line. */
  obsoletesOf: Record<string, string[]> = {
    'containerd.io': ['containerd <= 1.2.0', 'runc'],
    'docker-ce': ['docker-ce-selinux <= 17.03.0'],
    'nvidia-container-toolkit': [
      'nvidia-container-runtime <= 3.5.0-1',
      'nvidia-container-runtime-hook <= 1.4.0-2',
    ],
  }

  /** Commands the executor marked long-running (package installs get their own timeout). */
  longRunning: string[] = []
  /** Commands the executor marked diagnostic (a short timeout of their own). */
  diagnostic: string[] = []
  /** What `journalctl -u docker.service` prints; null models a host without a journal to read. */
  journal: string | null = null

  exec = async (argv: string[], options?: { longRunning?: boolean; diagnostic?: boolean }) => {
    this.calls.push(argv)
    if (options?.longRunning) this.longRunning.push(argv.join(' '))
    if (options?.diagnostic) this.diagnostic.push(argv.join(' '))
    const line = argv.join(' ')
    for (const [prefix, failure] of Object.entries(this.failures))
      if (line.startsWith(prefix)) return { stdout: '', ...failure }
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
    const no = (code = 1) => ({ code, stdout: '', stderr: '' })
    const [program, sub] = argv
    // What dpkg-query and rpm really print under LC_ALL=C, "not installed" included.
    if (program === 'dpkg-query') {
      const name = argv[3]!
      if (this.packages.has(name)) return ok('install ok installed')
      return { code: 1, stdout: '', stderr: `dpkg-query: no packages found matching ${name}\n` }
    }
    if (program === 'rpm') {
      const name = argv[3]!
      if (this.packages.has(name)) return ok(`${name}\n`)
      return { code: 1, stdout: `package ${name} is not installed\n`, stderr: '' }
    }
    if (program === 'dnf' && sub === 'repoquery')
      return ok(`${(this.obsoletesOf[argv.at(-1)!] ?? []).join('\n')}\n`)
    if (program === 'apt-get' && sub === 'update') return ok()
    if ((program === 'apt-get' || program === 'dnf') && sub === 'install') {
      const names = argv.filter((a, i) => i > 1 && !a.startsWith('-') && !a.includes('::'))
      for (const name of names) this.packages.add(name)
      if (names.includes('docker-ce') && this.startsOnInstall) this.dockerActive = true
      return ok()
    }
    if (program === 'nvidia-ctk') {
      if (!this.ctkWrites) return ok()
      const current = this.files.get('/etc/docker/daemon.json')
      const json = current
        ? (JSON.parse(Buffer.from(current.data).toString('utf8')) as Record<string, unknown>)
        : {}
      json['runtimes'] = {
        ...(json['runtimes'] as object),
        nvidia: { path: 'nvidia-container-runtime', args: [] },
      }
      this.files.set('/etc/docker/daemon.json', {
        data: Buffer.from(JSON.stringify(json, null, 4)),
        mode: 0o644,
      })
      return ok()
    }
    if (program === 'systemctl' && sub === 'is-active') return this.dockerActive ? ok() : no(3)
    if (program === 'systemctl' && sub === 'is-enabled')
      return this.dockerEnabled ? ok('enabled\n') : { code: 1, stdout: 'disabled\n', stderr: '' }
    if (program === 'systemctl' && sub === 'enable') {
      this.dockerEnabled = true
      this.dockerActive = true
      this.reload()
      return ok()
    }
    if (program === 'systemctl' && sub === 'restart') {
      this.reload()
      return ok()
    }
    if (program === 'docker' && sub === 'info') {
      if (!this.dockerActive) return no()
      return ok(`${JSON.stringify(Object.fromEntries(this.loadedRuntimes.map((r) => [r, { path: r }])))}\n`)
    }
    if (program === 'id') {
      const user = this.users[argv[2]!]
      if (!user) return { code: 1, stdout: '', stderr: `id: '${argv[2]}': no such user` }
      return ok(sub === '-u' ? `${user.uid}\n` : `${user.groups.join(' ')}\n`)
    }
    if (program === 'journalctl') {
      if (this.journal === null) return { code: 1, stdout: '', stderr: 'No journal files were found.\n' }
      return ok(this.journal)
    }
    if (program === 'usermod') {
      this.users[argv[3]!]!.groups.push('docker')
      return ok()
    }
    throw new Error(`FakeHost does not model ${line}`)
  }

  /** What a (re)started daemon loads: runc, plus nvidia when daemon.json registers it. */
  private reload(): void {
    const file = this.files.get('/etc/docker/daemon.json')
    const registered = file ? Buffer.from(file.data).toString('utf8').includes('"nvidia"') : false
    this.loadedRuntimes = registered ? ['runc', 'nvidia'] : ['runc']
  }

  mutations(): string[] {
    const reads = ['dpkg-query', 'rpm', 'id', 'docker', 'journalctl']
    return this.calls
      .filter(
        ([program, sub]) =>
          !reads.includes(program!) &&
          !(program === 'systemctl' && sub!.startsWith('is-')) &&
          !(program === 'dnf' && sub === 'repoquery')
      )
      .map((argv) => argv.join(' '))
  }

  deps(
    requestText: string,
    over: Partial<HostStepExecutorDeps> = {}
  ): HostStepExecutorDeps & {
    results: Record<string, HostStepResult>
  } {
    const results: Record<string, HostStepResult> = {}
    return {
      results,
      readRequest: async () => requestText,
      writeResult: async (path, text) => {
        results[path] = JSON.parse(text) as HostStepResult
      },
      readFile: async (path) => this.files.get(path)?.data ?? null,
      writeFile: async (path, data, mode) => {
        this.files.set(path, { data, mode })
      },
      exec: this.exec,
      fetch: (async (input: string | URL | Request) => {
        const url = String(input)
        this.fetched.push(url)
        const body = KEY_TEXT[url]
        if (body === undefined) return new Response('not found', { status: 404 })
        return Object.defineProperty(new Response(body, { status: 200 }), 'url', { value: url })
      }) as typeof fetch,
      now: () => 42,
      invokingUid: this.invokingUid,
      ...over,
    }
  }
}

const ubuntu = (
  components: ContainerRuntimeComponent[],
  over: Partial<InstallContainerRuntimeParameters> = {}
) => ({
  user: 'alice',
  arch: 'x86_64' as const,
  family: 'apt' as const,
  distro_id: 'ubuntu',
  version_id: '24.04',
  components,
  ...over,
})
const fedora = (components: ContainerRuntimeComponent[]) =>
  ubuntu(components, { family: 'dnf', distro_id: 'fedora', version_id: '43' })

function requestFor(
  parameters: InstallContainerRuntimeParameters,
  over: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    schema_version: 1,
    step_id: 'step-1',
    operation_id: 'op-1',
    action: 'linux.install-container-runtime',
    recipe_id: 'linux.install-container-runtime',
    recipe_digest: INSTALL_CONTAINER_RUNTIME_RECIPE_DIGEST,
    parameters_digest: installContainerRuntimeParametersDigest(parameters),
    nonce: 'nonce-0001',
    expected_operation_revision: 4,
    data_folder: '/home/alice/.local/share/atomic',
    requested_at: 1,
    parameters,
    ...over,
  })
}

const everything: ContainerRuntimeComponent[] = [
  'docker-engine',
  'nvidia-container-toolkit',
  'nvidia-runtime',
  'docker-service',
  'docker-group',
]

async function run(host: FakeHost, text: string, over: Partial<HostStepExecutorDeps> = {}) {
  const deps = host.deps(text, over)
  const result = await executeHostStep(REQUEST, deps)
  expect(deps.results[RESULT]).toEqual(result)
  return result
}

describe('a clean Ubuntu host', () => {
  it('installs everything the plan lists, in order, and reports each step', async () => {
    const host = new FakeHost()
    const parameters = ubuntu(everything)
    const result = await run(host, requestFor(parameters))

    expect(result).toMatchObject({
      schema_version: 1,
      step_id: 'step-1',
      outcome: 'completed',
      exit_code: 0,
      finished_at: 42,
      nonce: 'nonce-0001',
      recipe_id: 'linux.install-container-runtime',
      recipe_digest: INSTALL_CONTAINER_RUNTIME_RECIPE_DIGEST,
      parameters_digest: installContainerRuntimeParametersDigest(parameters),
      error_code: null,
    })
    expect(result.steps.map((s) => [s.id, s.status])).toEqual([
      ['docker-key', 'applied'],
      ['docker-source', 'applied'],
      ['nvidia-key', 'applied'],
      ['nvidia-source', 'applied'],
      ['packages', 'applied'],
      ['nvidia-runtime', 'applied'],
      ['docker-service', 'applied'],
      ['docker-group', 'applied'],
    ])
    expect(host.mutations()).toEqual([
      'apt-get update -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/docker.list -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0 -o DPkg::Lock::Timeout=300',
      'apt-get update -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/nvidia-container-toolkit.list -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0 -o DPkg::Lock::Timeout=300',
      'apt-get install -y --no-install-recommends --no-remove -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold -o DPkg::Lock::Timeout=300 docker-ce docker-ce-cli containerd.io nvidia-container-toolkit',
      'nvidia-ctk runtime configure --runtime=docker',
      // docker-ce's postinst started a daemon nobody had yet: restarting it stops nothing of the
      // user's, and without it the runtime would not load until the next boot.
      'systemctl restart docker',
      'systemctl enable --now docker',
      'usermod -aG docker alice',
    ])
    // Only the package install runs under the long timeout that never SIGKILLs dpkg early.
    expect(host.longRunning).toEqual([host.mutations()[2]])
    expect(host.loadedRuntimes).toContain('nvidia')
    expect(host.fetched).toEqual([
      'https://download.docker.com/linux/ubuntu/gpg',
      'https://nvidia.github.io/libnvidia-container/gpgkey',
    ])
    // Docker's key is stored as served; NVIDIA's is dearmored for its `.gpg` keyring.
    const dockerKey = host.files.get('/etc/apt/keyrings/docker.asc')!
    expect(Buffer.from(dockerKey.data).toString('utf8')).toBe(
      KEY_TEXT['https://download.docker.com/linux/ubuntu/gpg']
    )
    expect(dockerKey.mode).toBe(0o644)
    const nvidiaKey = host.files.get('/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg')!
    expect(nvidiaKey.data[0]).toBe(0x99) // an old-format public-key packet, not armor text
    expect(
      Buffer.from(host.files.get('/etc/apt/sources.list.d/docker.list')!.data).toString('utf8')
    ).toContain('https://download.docker.com/linux/ubuntu noble stable')
  })

  it('a second run of the same request changes nothing and still reports completed', async () => {
    const host = new FakeHost()
    const text = requestFor(ubuntu(everything))
    await run(host, text)
    host.calls = []
    host.fetched = []
    const files = new Map(host.files)

    const replay = await run(host, text)
    expect(replay.outcome).toBe('completed')
    expect(replay.steps.every((s) => s.status === 'satisfied')).toBe(true)
    expect(host.mutations()).toEqual([])
    expect(host.fetched).toEqual([])
    expect(host.files).toEqual(files)
  })
})

describe('refusing a request before anything runs', () => {
  const parameters = ubuntu(everything)

  it.each<[string, string, RegExp]>([
    [
      'a recipe digest from another build',
      requestFor(parameters, { recipe_digest: `sha256:${'0'.repeat(64)}` }),
      /recipe_digest/,
    ],
    [
      'a parameters digest that does not match the parameters',
      requestFor(parameters, {
        parameters_digest: installContainerRuntimeParametersDigest(ubuntu(['docker-group'])),
      }),
      /parameters_digest/,
    ],
    [
      'parameters swapped after the digest was taken',
      requestFor(parameters, { parameters: { ...parameters, user: 'bob' } }),
      /parameters_digest/,
    ],
    ['an unknown recipe', requestFor(parameters, { recipe_id: 'linux.install-anything' }), /unknown recipe/],
    ['another action', requestFor(parameters, { action: 'windows.enable-wsl' }), /windows\.enable-wsl/],
    [
      'parameters the recipe cannot build',
      requestFor(parameters, { parameters: { ...parameters, arch: 'riscv64' } }),
      /arch/,
    ],
    [
      'root in the docker group',
      requestFor(parameters, { parameters: { ...parameters, user: 'root' } }),
      /root/,
    ],
    ['not JSON at all', 'garbage', /not valid JSON/],
    ['an empty file', '', /not valid JSON/],
    ['a JSON array', '[]', /object/],
  ])('%s', async (_name, text, message) => {
    const host = new FakeHost()
    const result = await run(host, text)
    expect(result).toMatchObject({
      outcome: 'failed',
      exit_code: null,
      error_code: 'MANAGED_HOST_STEP_INVALID',
      steps: [],
    })
    expect(result.log_tail).toMatch(message)
    expect(host.calls).toEqual([])
    expect(host.fetched).toEqual([])
    expect(host.files.size).toBe(0)
  })

  it('echoes the nonce and the digests it was given, so the refusal can be matched to its step', async () => {
    const result = await run(
      new FakeHost(),
      requestFor(parameters, { recipe_digest: `sha256:${'0'.repeat(64)}` })
    )
    expect(result).toMatchObject({
      step_id: 'step-1',
      nonce: 'nonce-0001',
      recipe_digest: `sha256:${'0'.repeat(64)}`,
      parameters_digest: installContainerRuntimeParametersDigest(parameters),
    })
  })

  it('writes a failed result when the request cannot be read at all', async () => {
    const host = new FakeHost()
    const result = await run(host, '', {
      readRequest: async () => {
        throw Object.assign(new Error('ELOOP: too many symbolic links'), { code: 'ELOOP' })
      },
    })
    expect(result).toMatchObject({
      outcome: 'failed',
      step_id: '',
      nonce: null,
      error_code: 'MANAGED_HOST_STEP_INVALID',
    })
    expect(result.log_tail).toContain('ELOOP')
  })

  it('refuses a request whose step_id is not the one its file is named for', async () => {
    const host = new FakeHost()
    const result = await run(host, requestFor(parameters, { step_id: 'step-2' }))
    expect(result).toMatchObject({
      outcome: 'failed',
      error_code: 'MANAGED_HOST_STEP_INVALID',
      step_id: 'step-2',
    })
    expect(result.log_tail).toMatch(/step_id step-2 does not match .*step-1\.request\.json/)
    expect(host.calls).toEqual([])
  })

  it('keeps a refusal short however much junk the request carries', async () => {
    const junk = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`key_${i}_${'x'.repeat(40)}`, 1]))
    const result = await run(
      new FakeHost(),
      requestFor(parameters, { parameters: { ...parameters, ...junk } })
    )
    expect(result.outcome).toBe('failed')
    expect(result.log_tail.length).toBeLessThanOrEqual(2000)
  })

  it('names a refusal of the request file itself in the result', async () => {
    const result = await run(new FakeHost(), '', {
      readRequest: async () => {
        throw new AtomicCoreError(
          'MANAGED_HOST_STEP_INVALID',
          '/x/step-1.request.json is group- or world-writable'
        )
      },
    })
    expect(result.log_tail).toContain('group- or world-writable')
  })

  it('refuses a request path it could not name a result file for', async () => {
    const host = new FakeHost()
    await expect(executeHostStep('/tmp/step.json', host.deps(requestFor(parameters)))).rejects.toMatchObject({
      code: 'MANAGED_HOST_STEP_INVALID',
    })
  })
})

describe('a step that fails', () => {
  it('stops there, reports its exit code and stderr, and runs nothing after it', async () => {
    const host = new FakeHost()
    host.failures['apt-get install'] = {
      code: 100,
      stderr: `${'noise\n'.repeat(1000)}E: Unable to locate package containerd.io\n`,
    }
    const result = await run(host, requestFor(ubuntu(everything)))
    expect(result).toMatchObject({ outcome: 'failed', exit_code: 100, error_code: null })
    expect(result.steps.map((s) => [s.id, s.status])).toEqual([
      ['docker-key', 'applied'],
      ['docker-source', 'applied'],
      ['nvidia-key', 'applied'],
      ['nvidia-source', 'applied'],
      ['packages', 'failed'],
      ['nvidia-runtime', 'not-run'],
      ['docker-service', 'not-run'],
      ['docker-group', 'not-run'],
    ])
    const failed = result.steps[4]!
    expect(failed.exit_code).toBe(100)
    expect(failed.stderr).toMatch(/E: Unable to locate package containerd\.io$/)
    expect(failed.stderr.length).toBeLessThanOrEqual(2000)
    expect(result.log_tail).toContain('Unable to locate package')
    expect(host.calls.some(([program]) => program === 'nvidia-ctk' || program === 'usermod')).toBe(false)
  })

  it('a key that is not the pinned one is never written', async () => {
    const host = new FakeHost()
    const wrongKey = KEY_TEXT['https://download.docker.com/linux/fedora/gpg']!
    const result = await run(host, requestFor(ubuntu(['docker-engine'])), {
      fetch: (async (url: string) =>
        Object.defineProperty(new Response(wrongKey), 'url', { value: url })) as unknown as typeof fetch,
    })
    expect(result.outcome).toBe('failed')
    expect(result.steps[0]).toMatchObject({ id: 'docker-key', status: 'failed' })
    expect(result.steps[0]!.detail).toMatch(/060A61C51B558A7F742B77AAC52FEB6B621E9F35/)
    expect(host.files.size).toBe(0)
    expect(host.calls).toEqual([])
  })

  it.each<[string, () => Response, RegExp]>([
    ['an HTTP error', () => new Response('nope', { status: 503 }), /503/],
    [
      'an empty body',
      () =>
        Object.defineProperty(new Response(''), 'url', {
          value: 'https://download.docker.com/linux/ubuntu/gpg',
        }),
      /empty/,
    ],
    [
      'a redirect to plain http',
      () => Object.defineProperty(new Response('x'), 'url', { value: 'http://evil.example/gpg' }),
      /https/,
    ],
    [
      'an HTML page',
      () =>
        Object.defineProperty(new Response('<html></html>'), 'url', {
          value: 'https://download.docker.com/linux/ubuntu/gpg',
        }),
      /armored/,
    ],
  ])('a key download with %s fails the step', async (_name, response, message) => {
    const host = new FakeHost()
    const result = await run(host, requestFor(ubuntu(['docker-engine'])), {
      fetch: (async () => response()) as unknown as typeof fetch,
    })
    expect(result.steps[0]).toMatchObject({ id: 'docker-key', status: 'failed' })
    expect(result.steps[0]!.detail).toMatch(message)
    expect(host.files.size).toBe(0)
  })

  it('a network error fails the step instead of escaping', async () => {
    const host = new FakeHost()
    const result = await run(host, requestFor(ubuntu(['docker-engine'])), {
      fetch: (async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch,
    })
    expect(result.steps[0]).toMatchObject({ status: 'failed', detail: expect.stringMatching(/fetch failed/) })
  })
})

describe('never over or around what is already there', () => {
  it('moby-engine or docker.io present: Docker is not installed over it, and nothing is removed', async () => {
    const host = new FakeHost()
    host.packages.add('docker.io')
    const result = await run(host, requestFor(ubuntu(['docker-engine', 'nvidia-container-toolkit'])))
    expect(result.outcome).toBe('failed')
    expect(result.steps.find((s) => s.id === 'packages')).toMatchObject({
      status: 'failed',
      detail: expect.stringMatching(/docker\.io is installed/),
    })
    expect(host.calls.some(([program, sub]) => program === 'apt-get' && sub === 'install')).toBe(false)
  })

  // RPM Obsoletes: a plain `dnf install` of the right-hand package would replace the left-hand one.
  it.each<[string, ContainerRuntimeComponent[], string]>([
    ['nvidia-container-runtime', ['nvidia-container-toolkit'], 'toolkit only'],
    ['nvidia-container-runtime-hook', ['nvidia-container-toolkit'], 'toolkit only'],
    ['nvidia-container-runtime', ['docker-engine', 'nvidia-container-toolkit'], 'docker and toolkit'],
    ['nvidia-container-runtime-hook', ['docker-engine', 'nvidia-container-toolkit'], 'docker and toolkit'],
    ['containerd', ['docker-engine'], 'docker only'],
    ['runc', ['docker-engine'], 'docker only'],
    ['docker-ce-selinux', ['docker-engine'], 'docker only'],
    ['containerd', ['docker-engine', 'nvidia-container-toolkit'], 'docker and toolkit'],
    ['runc', ['docker-engine', 'nvidia-container-toolkit'], 'docker and toolkit'],
    ['docker-ce-selinux', ['docker-engine', 'nvidia-container-toolkit'], 'docker and toolkit'],
  ])(
    'Fedora with %s installed (%j, %s): refused, nothing installed or replaced',
    async (installed, components) => {
      const host = new FakeHost()
      host.packages.add(installed)
      host.startsOnInstall = false
      const result = await run(host, requestFor(fedora(components)))
      expect(result.outcome).toBe('failed')
      const packages = result.steps.find((s) => s.id === 'packages')!
      expect(packages).toMatchObject({
        status: 'failed',
        detail: expect.stringContaining(`${installed} is installed`),
      })
      expect(packages.detail).toMatch(/Nothing was installed and nothing was removed/)
      expect(host.calls.some(([program, sub]) => program === 'dnf' && sub === 'install')).toBe(false)
    }
  )

  describe('the live Obsoletes check on dnf', () => {
    it.each<[string, string, ContainerRuntimeComponent[]]>([
      // Obsoleted in the repositories but on no static list: only the live check can see them.
      ['docker-ce', 'docker-compose-legacy', ['docker-engine']],
      ['containerd.io', 'containerd-shim-legacy', ['docker-engine']],
      ['nvidia-container-toolkit', 'nvidia-docker2', ['nvidia-container-toolkit']],
      [
        'nvidia-container-toolkit',
        'nvidia-container-hook-old',
        ['docker-engine', 'nvidia-container-toolkit'],
      ],
    ])(
      '%s obsoletes installed %s: refused before installing, nothing removed',
      async (installing, obsoleted, components) => {
        const host = new FakeHost()
        host.startsOnInstall = false
        host.packages.add(obsoleted)
        host.obsoletesOf[installing] = [...host.obsoletesOf[installing]!, `${obsoleted} < 2.0`]
        const result = await run(host, requestFor(fedora(components)))
        const packages = result.steps.find((s) => s.id === 'packages')!
        expect(packages).toMatchObject({ status: 'failed' })
        expect(packages.detail).toContain(
          `${obsoleted} is installed, and installing ${installing} would replace it (RPM Obsoletes)`
        )
        expect(packages.detail).toMatch(/Nothing was installed and nothing was removed/)
        expect(host.calls.some(([program, sub]) => program === 'dnf' && sub === 'install')).toBe(false)
      }
    )

    it('asks rpm about the obsoleted name only, so a package merely providing it is no conflict', async () => {
      // nvidia-container-toolkit-base provides `nvidia-container-runtime` but is not named that;
      // libsolv matches Obsoletes against names, so the install would not replace it.
      const host = new FakeHost()
      host.startsOnInstall = false
      host.packages.add('nvidia-container-toolkit-base')
      const result = await run(host, requestFor(fedora(['nvidia-container-toolkit'])))
      expect(result.outcome).toBe('completed')
      const rpm = host.calls.filter(([program]) => program === 'rpm').map((argv) => argv.join(' '))
      expect(rpm).toContain('rpm --query --queryformat=%{NAME}\\n nvidia-container-runtime')
      expect(rpm.every((line) => line.startsWith('rpm --query --queryformat=%{NAME}\\n '))).toBe(true)
    })

    it('a recipe package already installed is never read as what the install would replace', async () => {
      // containerd.io both provides and obsoletes `containerd`; a name-only query of `containerd`
      // does not see containerd.io, so finishing docker-ce is not refused over it.
      const host = new FakeHost()
      host.startsOnInstall = false
      host.packages.add('containerd.io')
      const result = await run(host, requestFor(fedora(['docker-engine'])))
      expect(result.outcome).toBe('completed')
      expect(host.mutations()).toEqual([
        'dnf install -y --setopt=install_weak_deps=False docker-ce docker-ce-cli',
      ])
      // Only the packages still to install are asked about.
      expect(
        host.calls.filter(([program, sub]) => program === 'dnf' && sub === 'repoquery').map((c) => c.at(-1))
      ).toEqual(['docker-ce', 'docker-ce-cli'])
    })

    it('a repoquery that fails, or prints something that is not a package name, fails the step', async () => {
      const failing = new FakeHost()
      failing.failures['dnf repoquery'] = { code: 1, stderr: 'Failed to download metadata' }
      const failed = await run(failing, requestFor(fedora(['nvidia-container-toolkit'])))
      expect(failed.steps.find((s) => s.id === 'packages')).toMatchObject({ status: 'failed', exit_code: 1 })
      expect(failing.calls.some(([program, sub]) => program === 'dnf' && sub === 'install')).toBe(false)

      for (const line of ['-rf /', 'config(nvidia-container-toolkit) < 2']) {
        const odd = new FakeHost()
        odd.obsoletesOf['nvidia-container-toolkit'] = [line]
        const refused = await run(odd, requestFor(fedora(['nvidia-container-toolkit'])))
        expect(refused.steps.find((s) => s.id === 'packages')!.detail).toMatch(/not a package name/)
        expect(odd.calls.some(([program, sub]) => program === 'dnf' && sub === 'install')).toBe(false)
      }
    })
  })

  describe('a package query that does not answer "not installed" in so many words fails closed', () => {
    const RPMDB = 'error: cannot open Packages database in /var/lib/rpm'
    // What rpm really prints when it cannot open its database (final review T-247, N1): the error on
    // stderr *and* the usual "not installed" line on stdout, so only the stderr guard tells them apart.
    const rpmdb = (name: string) => ({ code: 1, stdout: `package ${name} is not installed\n`, stderr: RPMDB })
    const rpmQuery = (name: string) => `rpm --query --queryformat=%{NAME}\\n ${name}`
    // Each case breaks one query. The step must fail with nothing installed: a broken query is never
    // read as "not installed", which would let a conflict slip through or an install run blind.
    it.each<{
      name: string
      broken: string
      components: ContainerRuntimeComponent[]
      answer: { code: number | null; stdout?: string; stderr: string }
    }>([
      {
        name: 'rpm cannot open its database: is a recipe package installed?',
        broken: rpmQuery('nvidia-container-toolkit'),
        components: ['nvidia-container-toolkit'],
        answer: rpmdb('nvidia-container-toolkit'),
      },
      {
        name: 'rpm cannot open its database: is a conflict installed?',
        broken: rpmQuery('moby-engine'),
        components: ['docker-engine'],
        answer: rpmdb('moby-engine'),
      },
      {
        name: 'rpm cannot open its database: is a name the repositories obsolete installed?',
        broken: rpmQuery('nvidia-docker2'),
        components: ['nvidia-container-toolkit'],
        answer: rpmdb('nvidia-docker2'),
      },
      {
        name: 'rpm could not run at all',
        broken: 'rpm',
        components: ['nvidia-container-toolkit'],
        answer: { code: null, stderr: 'spawn rpm ENOENT' },
      },
      {
        name: 'rpm exits 1 with a reply other than "package <name> is not installed"',
        broken: rpmQuery('nvidia-container-toolkit'),
        components: ['nvidia-container-toolkit'],
        answer: { code: 1, stdout: 'package nvidia-container-toolkit is locked\n', stderr: '' },
      },
      {
        name: 'rpm answers with another package than the one asked about',
        broken: rpmQuery('nvidia-container-toolkit'),
        components: ['nvidia-container-toolkit'],
        answer: { code: 0, stdout: 'nvidia-container\n', stderr: '' },
      },
      {
        name: 'dpkg-query fails outright',
        broken: 'dpkg-query',
        components: ['nvidia-container-toolkit'],
        answer: { code: 2, stderr: 'dpkg-query: error: parsing file /var/lib/dpkg/status' },
      },
      {
        name: 'dpkg-query exits 1 without saying the package is unknown',
        broken: 'dpkg-query --show --showformat=${Status} docker.io',
        components: ['docker-engine'],
        answer: { code: 1, stderr: '' },
      },
      {
        // Pins the `stdout === ''` guard (final review T-247, N1): the "unknown" line alone is not
        // enough when dpkg-query also printed something about the package.
        name: 'dpkg-query says the package is unknown but also printed a status',
        broken: 'dpkg-query --show --showformat=${Status} docker.io',
        components: ['docker-engine'],
        answer: {
          code: 1,
          stdout: 'install ok half-configured',
          stderr: 'dpkg-query: no packages found matching docker.io',
        },
      },
    ])('$name', async ({ broken, components, answer }) => {
      const host = new FakeHost()
      host.obsoletesOf['nvidia-container-toolkit']!.push('nvidia-docker2 < 2.0')
      host.failures[broken] = answer
      const plan = broken.startsWith('dpkg') ? ubuntu(components) : fedora(components)
      const result = await run(host, requestFor(plan))
      expect(result.steps.find((s) => s.id === 'packages')).toMatchObject({
        status: 'failed',
        exit_code: answer.code,
        detail: expect.stringMatching(/^could not tell whether \S+ is installed$/),
      })
      expect(host.calls.some(([, sub]) => sub === 'install')).toBe(false)
      expect(host.calls.some((argv) => argv.join(' ').startsWith(broken))).toBe(true)
    })
  })

  it('the toolkit-only plan on a moby host installs only the toolkit', async () => {
    const host = new FakeHost()
    host.packages.add('moby-engine')
    host.startsOnInstall = false
    const result = await run(host, requestFor(fedora(['nvidia-container-toolkit'])))
    expect(result.outcome).toBe('completed')
    expect(host.mutations()).toEqual([
      'dnf install -y --setopt=install_weak_deps=False nvidia-container-toolkit',
    ])
    expect(host.files.has('/etc/yum.repos.d/docker-ce.repo')).toBe(false)
  })

  it('installs only the packages still missing, never re-naming an installed one', async () => {
    const host = new FakeHost()
    for (const name of DOCKER) host.packages.add(name)
    host.packages.delete('docker-ce-cli')
    await run(host, requestFor(ubuntu(['docker-engine', 'nvidia-container-toolkit'])))
    const install = host.calls.find(([program, sub]) => program === 'apt-get' && sub === 'install')!
    expect(install.slice(-2)).toEqual(['docker-ce-cli', 'nvidia-container-toolkit'])
  })

  it('an existing repository file or key is kept as it is, never overwritten', async () => {
    const host = new FakeHost()
    const mine = { data: Buffer.from('deb https://mirror.example/docker noble stable\n'), mode: 0o600 }
    host.files.set('/etc/apt/sources.list.d/docker.list', mine)
    const result = await run(host, requestFor(ubuntu(['docker-engine'])))
    expect(host.files.get('/etc/apt/sources.list.d/docker.list')).toBe(mine)
    expect(result.steps.find((s) => s.id === 'docker-source')).toMatchObject({
      status: 'satisfied',
      detail: expect.stringMatching(/kept/),
    })
  })
})

describe('the runtime configuration and the Docker restart', () => {
  const daemonJson = (host: FakeHost) =>
    host.files.has('/etc/docker/daemon.json')
      ? Buffer.from(host.files.get('/etc/docker/daemon.json')!.data).toString('utf8')
      : null
  const restarted = (host: FakeHost) => host.mutations().includes('systemctl restart docker')

  it('restarts a running Docker when the configuration changed and the plan included the restart', async () => {
    const host = new FakeHost()
    host.dockerActive = true
    const result = await run(host, requestFor(ubuntu(['nvidia-runtime', 'docker-restart'])))
    expect(result.outcome).toBe('completed')
    expect(daemonJson(host)).toContain('nvidia')
    expect(restarted(host)).toBe(true)
    expect(host.loadedRuntimes).toContain('nvidia')
  })

  it('does not restart a running Docker the plan did not ask to restart, and says so', async () => {
    const host = new FakeHost()
    host.dockerActive = true
    const result = await run(host, requestFor(ubuntu(['nvidia-runtime'])))
    expect(result.outcome).toBe('completed')
    expect(restarted(host)).toBe(false)
    expect(result.steps[0]).toMatchObject({
      status: 'applied',
      detail: expect.stringMatching(/not restarted/),
    })
  })

  it('does not restart when nvidia-ctk left daemon.json exactly as it was', async () => {
    const host = new FakeHost()
    host.dockerActive = true
    host.ctkWrites = false
    await run(host, requestFor(ubuntu(['nvidia-runtime', 'docker-restart'])))
    expect(host.mutations()).toEqual(['nvidia-ctk runtime configure --runtime=docker'])
  })

  it('does not run nvidia-ctk or restart when the running Docker already has the runtime', async () => {
    const host = new FakeHost()
    host.dockerActive = true
    host.files.set('/etc/docker/daemon.json', {
      data: Buffer.from('{"runtimes":{"nvidia":{}}}'),
      mode: 0o644,
    })
    host.loadedRuntimes = ['runc', 'nvidia']
    const result = await run(host, requestFor(ubuntu(['nvidia-runtime', 'docker-restart'])))
    expect(result.steps[0]).toMatchObject({ status: 'satisfied' })
    expect(host.mutations()).toEqual([])
  })

  it('registered on disk but not loaded by the running daemon: the approved restart loads it', async () => {
    // Someone ran `nvidia-ctk runtime configure` by hand and never restarted Docker.
    const host = new FakeHost()
    host.dockerActive = true
    host.files.set('/etc/docker/daemon.json', {
      data: Buffer.from('{"runtimes":{"nvidia":{}}}'),
      mode: 0o644,
    })
    await run(host, requestFor(ubuntu(['nvidia-runtime', 'docker-restart'])))
    expect(host.mutations()).toEqual(['systemctl restart docker'])
  })

  it('does not restart a Docker that is not running; enabling the service starts it with the new config', async () => {
    const host = new FakeHost()
    host.startsOnInstall = false
    await run(host, requestFor(fedora(['nvidia-runtime', 'docker-service'])))
    expect(host.mutations()).toEqual([
      'nvidia-ctk runtime configure --runtime=docker',
      'systemctl enable --now docker',
    ])
    expect(host.loadedRuntimes).toContain('nvidia')
  })

  it('reads a daemon.json it cannot parse as not registering the runtime, and configures it', async () => {
    const host = new FakeHost()
    host.files.set('/etc/docker/daemon.json', { data: Buffer.from('{ not json'), mode: 0o644 })
    host.ctkWrites = false
    await run(host, requestFor(ubuntu(['nvidia-runtime'])))
    expect(host.mutations()).toEqual(['nvidia-ctk runtime configure --runtime=docker'])
  })

  it('registered, Docker stopped: nothing to do', async () => {
    const host = new FakeHost()
    host.files.set('/etc/docker/daemon.json', {
      data: Buffer.from('{"runtimes":{"nvidia":{}}}'),
      mode: 0o644,
    })
    const result = await run(host, requestFor(ubuntu(['nvidia-runtime', 'docker-restart'])))
    expect(result.steps[0]).toMatchObject({ status: 'satisfied' })
    expect(host.mutations()).toEqual([])
  })

  it('a docker info it cannot parse counts as not loaded, and the approved restart runs', async () => {
    const host = new FakeHost()
    host.dockerActive = true
    host.files.set('/etc/docker/daemon.json', {
      data: Buffer.from('{"runtimes":{"nvidia":{}}}'),
      mode: 0o644,
    })
    const exec = host.exec
    const garbled: typeof exec = async (argv, options) =>
      argv[0] === 'docker' ? { code: 0, stdout: 'not json', stderr: '' } : exec(argv, options)
    await run(host, requestFor(ubuntu(['nvidia-runtime', 'docker-restart'])), { exec: garbled })
    expect(host.mutations()).toEqual(['systemctl restart docker'])
  })

  it('a failed nvidia-ctk fails the step with its exit code', async () => {
    const host = new FakeHost()
    host.failures['nvidia-ctk'] = { code: 1, stderr: 'unable to load config' }
    const result = await run(host, requestFor(ubuntu(['nvidia-runtime'])))
    expect(result).toMatchObject({ outcome: 'failed', exit_code: 1 })
  })
})

describe('whatever goes wrong, a result file is written', () => {
  it('an error outside any step still ends in a failed result, not a missing file', async () => {
    const host = new FakeHost()
    let calls = 0
    const result = await run(host, requestFor(ubuntu(['docker-group'])), {
      now: () => {
        calls += 1
        if (calls === 1) throw new Error('clock unavailable')
        return 42
      },
    })
    expect(result).toMatchObject({ outcome: 'failed', error_code: null, finished_at: 42 })
    expect(result.log_tail).toMatch(/stopped unexpectedly: clock unavailable/)
  })

  it('a Docker probe that throws before the first step still ends in a failed result', async () => {
    const host = new FakeHost()
    const result = await run(host, requestFor(ubuntu(['nvidia-runtime'])), {
      exec: async () => {
        throw new Error('spawn EAGAIN')
      },
    })
    expect(result).toMatchObject({ outcome: 'failed', error_code: null })
    expect(result.log_tail).toMatch(/spawn EAGAIN/)
    expect(result.steps).toEqual([
      expect.objectContaining({
        id: 'nvidia-runtime',
        status: 'failed',
        detail: expect.stringMatching(/EAGAIN/),
      }),
    ])
  })
})

describe('the service and the docker group', () => {
  it('enables and starts docker.service only when it is not already enabled and running', async () => {
    const host = new FakeHost()
    host.dockerActive = true
    host.dockerEnabled = true
    const result = await run(host, requestFor(ubuntu(['docker-service'])))
    expect(result.steps[0]).toMatchObject({ status: 'satisfied' })
    expect(host.mutations()).toEqual([])
  })

  it('adds the user who asked, once', async () => {
    const host = new FakeHost()
    await run(host, requestFor(ubuntu(['docker-group'])))
    expect(host.mutations()).toEqual(['usermod -aG docker alice'])
    host.calls = []
    await run(host, requestFor(ubuntu(['docker-group'])))
    expect(host.mutations()).toEqual([])
  })

  it('refuses a name that is uid 0 under another name', async () => {
    const host = new FakeHost()
    host.invokingUid = null
    const result = await run(host, requestFor(ubuntu(['docker-group'], { user: 'toor' })))
    expect(result.steps[0]).toMatchObject({ status: 'failed', detail: expect.stringMatching(/uid 0/) })
    expect(host.mutations()).toEqual([])
  })

  it('refuses to add anyone but the user who asked for elevation', async () => {
    const host = new FakeHost()
    host.users['bob'] = { uid: '1001', groups: ['bob'] }
    const result = await run(host, requestFor(ubuntu(['docker-group'], { user: 'bob' })))
    expect(result.steps[0]).toMatchObject({ status: 'failed', detail: expect.stringMatching(/1000/) })
    expect(host.mutations()).toEqual([])
  })

  it('refuses a user that does not exist', async () => {
    const host = new FakeHost()
    const result = await run(host, requestFor(ubuntu(['docker-group'], { user: 'ghost' })))
    expect(result.steps[0]).toMatchObject({ status: 'failed', detail: expect.stringMatching(/ghost/) })
  })
})

describe("why Docker did not start: the journal tail joins systemctl's own stderr", () => {
  const JOURNAL = ['journalctl', '-u', 'docker.service', '-n', '40', '--no-pager', '-o', 'cat']
  const SYSTEMCTL_SAID =
    'Job for docker.service failed because the control process exited with error code.\n' +
    'See "systemctl status docker.service" and "journalctl -xeu docker.service" for details.\n'
  const REASON =
    'failed to start daemon: Error initializing network controller: error obtaining controller instance: ' +
    'failed to create NAT chain DOCKER: all predefined address pools have been fully subnetted'

  const failingEnable = (host: FakeHost) => {
    host.failures['systemctl enable'] = { code: 1, stderr: SYSTEMCTL_SAID }
  }

  it('enabling docker.service fails: the step keeps its exit code and detail, and its stderr ends with the reason', async () => {
    const host = new FakeHost()
    failingEnable(host)
    host.journal = `Starting docker.service - Docker Application Container Engine...\n${REASON}\n`
    const result = await run(host, requestFor(ubuntu(['docker-service', 'docker-group'])))
    expect(result).toMatchObject({ outcome: 'failed', exit_code: 1 })
    expect(result.steps[0]).toMatchObject({
      id: 'docker-service',
      status: 'failed',
      exit_code: 1,
      detail: 'systemctl enable --now docker exited with 1',
    })
    expect(result.steps[0]!.stderr).toContain('journalctl -xeu docker.service')
    expect(result.steps[0]!.stderr).toContain('journalctl -u docker.service:')
    expect(result.steps[0]!.stderr.endsWith(REASON)).toBe(true)
    expect(result.log_tail).toContain('all predefined address pools have been fully subnetted')
    expect(result.steps[1]).toMatchObject({ id: 'docker-group', status: 'not-run' })
    // The journal is read with the recipe's own argv, on the short diagnostic deadline, and changes nothing.
    expect(host.calls).toContainEqual(JOURNAL)
    expect(host.diagnostic).toEqual([JOURNAL.join(' ')])
    expect(host.mutations()).toEqual(['systemctl enable --now docker'])
  })

  it('an approved restart that fails carries the reason too', async () => {
    const host = new FakeHost()
    host.dockerActive = true
    host.failures['systemctl restart'] = { code: 1, stderr: SYSTEMCTL_SAID }
    host.journal = `${REASON}\n`
    const result = await run(host, requestFor(ubuntu(['nvidia-runtime', 'docker-restart'])))
    expect(result.steps[0]).toMatchObject({ id: 'nvidia-runtime', status: 'failed', exit_code: 1 })
    expect(result.steps[0]!.stderr.endsWith(REASON)).toBe(true)
  })

  it.each<[string, (host: FakeHost) => Partial<HostStepExecutorDeps>]>([
    ['journalctl answers with an error', () => ({})],
    [
      'journalctl is not installed',
      (host) => ({
        exec: async (argv, options) =>
          argv[0] === 'journalctl'
            ? { code: null, stdout: '', stderr: 'spawn journalctl ENOENT' }
            : host.exec(argv, options),
      }),
    ],
    [
      'running journalctl throws',
      (host) => ({
        exec: async (argv, options) => {
          if (argv[0] === 'journalctl') throw new Error('spawn EAGAIN')
          return host.exec(argv, options)
        },
      }),
    ],
    [
      'the journal is empty',
      (host) => {
        host.journal = '\n'
        return {}
      },
    ],
  ])('%s: nothing is appended and the outcome is the same', async (_label, over) => {
    const host = new FakeHost()
    failingEnable(host)
    const result = await run(host, requestFor(ubuntu(['docker-service'])), over(host))
    expect(result).toMatchObject({ outcome: 'failed', exit_code: 1 })
    expect(result.steps[0]).toMatchObject({
      status: 'failed',
      exit_code: 1,
      detail: 'systemctl enable --now docker exited with 1',
      stderr: SYSTEMCTL_SAID.trim(),
    })
  })

  it('a long journal is cut to the step stderr limit, keeping its end', async () => {
    const host = new FakeHost()
    failingEnable(host)
    host.journal = `${'x'.repeat(5000)}\n${REASON}\n`
    const result = await run(host, requestFor(ubuntu(['docker-service'])))
    expect(result.steps[0]!.stderr.length).toBeLessThanOrEqual(2000)
    expect(result.steps[0]!.stderr.endsWith(REASON)).toBe(true)
    expect(result.log_tail.length).toBeLessThanOrEqual(2000)
  })

  it('a docker.service that starts is never followed by a journal read', async () => {
    const host = new FakeHost()
    host.journal = REASON
    const result = await run(host, requestFor(ubuntu(['nvidia-runtime', 'docker-service'])))
    expect(result.outcome).toBe('completed')
    expect(host.calls.some(([program]) => program === 'journalctl')).toBe(false)
  })
})
