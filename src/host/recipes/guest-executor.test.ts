import { describe, expect, it } from 'vitest'
import type { WslDistributionTransport, WslExecOptions } from '../../runtime/wsl/index.js'
import { createGuestRecipeRunner, guestHostStepDeps } from './guest-executor.js'
import {
  INSTALL_CONTAINER_RUNTIME_RECIPE_DIGEST,
  INSTALL_CONTAINER_RUNTIME_RECIPE_ID,
  installContainerRuntimeParametersDigest,
} from './install-container-runtime.js'

/** A guest with a file system and nothing installed; every call is recorded. */
const guest = () => {
  const files: Record<string, string> = { '/etc/os-release': 'ID=ubuntu\n' }
  const calls: { argv: string[]; options: WslExecOptions }[] = []
  const transport: WslDistributionTransport = {
    name: 'AtomicChat',
    exec: async (argv, options = {}) => {
      calls.push({ argv, options })
      const [command, ...args] =
        argv[0] === 'env'
          ? argv.slice(argv.findIndex((a) => !a.includes('=') && a !== 'env' && a !== '-i'))
          : argv
      const last = args[args.length - 1] as string
      switch (command) {
        case 'test':
          return { code: last in files ? 0 : 1, stdout: '', stderr: '' }
        case 'cat':
          return last in files
            ? { code: 0, stdout: files[last] as string, stderr: '' }
            : { code: 1, stdout: '', stderr: 'no such file' }
        case 'tee':
          files[last] = Buffer.from(options.input ?? '').toString('utf8')
          return { code: 0, stdout: '', stderr: '' }
        case 'mv': {
          const [from, to] = args.filter((a) => !a.startsWith('-')) as [string, string]
          files[to] = files[from] as string
          delete files[from]
          return { code: 0, stdout: '', stderr: '' }
        }
        default:
          return { code: 0, stdout: '', stderr: '' }
      }
    },
    hold: () => {
      throw new Error('no hold')
    },
  }
  return { transport, files, calls }
}

describe('guestHostStepDeps', () => {
  it('runs every command as guest root in the recipe’s own clean environment, never through a shell', async () => {
    const { transport, calls } = guest()
    const deps = guestHostStepDeps(transport, { fetch, signal: new AbortController().signal })
    await deps.exec(['apt-get', 'install', '-y', 'docker-ce'], { longRunning: true })
    expect(calls[0]?.argv).toEqual([
      'env',
      '-i',
      'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      'LANG=C',
      'LC_ALL=C',
      'DEBIAN_FRONTEND=noninteractive',
      'apt-get',
      'install',
      '-y',
      'docker-ce',
    ])
    expect(calls[0]?.options.user).toBe('root')
    // A package install gets hours, not the default minute.
    expect(calls[0]?.options.timeoutMs).toBeGreaterThanOrEqual(60 * 60_000)
  })

  it('reads a guest file, null when it is not there', async () => {
    const { transport } = guest()
    const deps = guestHostStepDeps(transport, { fetch, signal: new AbortController().signal })
    expect(Buffer.from((await deps.readFile('/etc/os-release')) ?? []).toString('utf8')).toBe('ID=ubuntu\n')
    expect(await deps.readFile('/etc/apt/keyrings/docker.asc')).toBeNull()
  })

  it('writes a guest file through a temporary name, with its mode, and moves it into place', async () => {
    const { transport, files, calls } = guest()
    const deps = guestHostStepDeps(transport, { fetch, signal: new AbortController().signal })
    await deps.writeFile('/etc/apt/sources.list.d/docker.list', Buffer.from('deb https://x stable\n'), 0o644)
    expect(files['/etc/apt/sources.list.d/docker.list']).toBe('deb https://x stable\n')
    expect(calls.map((call) => call.argv[0])).toEqual(['mkdir', 'tee', 'chmod', 'mv'])
    expect(calls[2]?.argv).toEqual(['chmod', '644', '/etc/apt/sources.list.d/docker.list.atomic-tmp'])
  })
})

describe('createGuestRecipeRunner', () => {
  it('refuses a request whose parameters do not match their digest, running nothing in the guest', async () => {
    const { transport, calls } = guest()
    const run = createGuestRecipeRunner({ fetch })
    const parameters = {
      user: 'root',
      arch: 'x86_64' as const,
      family: 'apt' as const,
      distro_id: 'ubuntu',
      version_id: '24.04',
      components: ['docker-engine' as const],
    }
    const answer = await run(
      transport,
      {
        recipe_id: INSTALL_CONTAINER_RUNTIME_RECIPE_ID,
        recipe_digest: INSTALL_CONTAINER_RUNTIME_RECIPE_DIGEST,
        parameters,
        parameters_digest: `sha256:${'0'.repeat(64)}`,
      },
      new AbortController().signal
    )
    expect(answer.outcome).toBe('failed')
    expect(answer.log_tail).toContain('parameters_digest')
    expect(calls).toEqual([])
    expect(installContainerRuntimeParametersDigest(parameters)).toMatch(/^sha256:/)
  })
})
