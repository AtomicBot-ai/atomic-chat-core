import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
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
  failures: Record<string, { code: number; stderr: string }> = {}
  calls: string[][] = []
  fetched: string[] = []
  invokingUid: string | null = '1000'

  /** Commands the executor marked long-running (package installs get their own timeout). */
  longRunning: string[] = []

  exec = async (argv: string[], options?: { longRunning?: boolean }) => {
    this.calls.push(argv)
    if (options?.longRunning) this.longRunning.push(argv.join(' '))
    const line = argv.join(' ')
    for (const [prefix, failure] of Object.entries(this.failures))
      if (line.startsWith(prefix)) return { code: failure.code, stdout: '', stderr: failure.stderr }
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
    const no = (code = 1) => ({ code, stdout: '', stderr: '' })
    const [program, sub] = argv
    if (program === 'dpkg-query') {
      const name = argv[3]!
      return this.packages.has(name) ? ok('install ok installed') : no()
    }
    if (program === 'rpm') return this.packages.has(argv[3]!) ? ok() : no()
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
    const reads = ['dpkg-query', 'rpm', 'id', 'docker']
    return this.calls
      .filter(
        ([program, sub]) => !reads.includes(program!) && !(program === 'systemctl' && sub!.startsWith('is-'))
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
