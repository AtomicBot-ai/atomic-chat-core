import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import { createWslManagedDeployment, hostPortListening } from './wsl-deployment.js'

const readiness = { path: '/health', expectedStatus: 200 }
let server: Server | null = null
afterEach(async () => {
  await new Promise<void>((resolve) => (server === null ? resolve() : server.close(() => resolve())))
  server = null
})

const deployment = (answers: { port?: string; inside?: string; listening?: boolean } = {}) => {
  const runs: string[][] = []
  return {
    runs,
    deployment: createWslManagedDeployment({
      distribution: 'AtomicChat',
      exec: async (args) => {
        runs.push(args)
        return { code: 0, stdout: answers.port ?? '127.0.0.1:49200\n', stderr: '' }
      },
      runInGuest: async (argv) => {
        runs.push(argv)
        return { code: 0, stdout: answers.inside ?? '200', stderr: '' }
      },
      hostPortListening: async () => answers.listening ?? false,
      forwardingError: () =>
        new AtomicCoreError('MANAGED_PREREQUISITE_BLOCKED', 'no forwarding', 'wsl-localhost-forwarding'),
    }),
  }
}

describe('createWslManagedDeployment', () => {
  it('leaves the port to Docker, mounts guest paths, and reads the port back after the start', async () => {
    const { deployment: d } = deployment()
    const heartbeat = '\\\\wsl.localhost\\AtomicChat\\var\\lib\\atomic-chat\\scopes\\k\\heartbeats\\g'
    const prepared = await d.prepareLaunch({ container_port: 8000 }, heartbeat)
    expect(prepared.publication).toEqual({ host: '127.0.0.1', host_port: 0, container_port: 8000 })
    expect(prepared.heartbeat.mount_source).toBe('/var/lib/atomic-chat/scopes/k/heartbeats/g')
    const resolved = await d.resolveTarget!('c1', prepared)
    expect(resolved.publication.host_port).toBe(49200)
    expect(resolved.target).toEqual({ base_url: 'http://127.0.0.1:49200' })
  })

  it('probes the engine inside the guest by its port and path, as root, without a shell', async () => {
    const { deployment: d, runs } = deployment({ inside: '200' })
    expect(await d.probeInGuest!({ base_url: 'http://127.0.0.1:49200' }, readiness)).toBe('ready')
    expect(runs.at(-1)).toEqual([
      'curl',
      '--silent',
      '--output',
      '/dev/null',
      '--write-out',
      '%{http_code}',
      '--max-time',
      '2',
      'http://127.0.0.1:49200/health',
    ])
    expect(
      await deployment({ inside: '503' }).deployment.probeInGuest!(
        { base_url: 'http://127.0.0.1:1' },
        readiness
      )
    ).toBe('not-ready')
  })

  it('tells a port another program holds on Windows from no forwarding at all', async () => {
    const target = { base_url: 'http://127.0.0.1:49200' }
    expect(await deployment({ listening: true }).deployment.diagnoseForwarding!(target)).toBe('port-taken')
    expect(await deployment({ listening: false }).deployment.diagnoseForwarding!(target)).toBe(
      'not-forwarded'
    )
    expect((await deployment().deployment.forwardingError!()).details).toBe('wsl-localhost-forwarding')
  })
})

describe('hostPortListening', () => {
  it('is true for a port something accepts connections on, false for one nobody does', async () => {
    server = createServer()
    const port = await new Promise<number>((resolve) =>
      server!.listen(0, '127.0.0.1', () => resolve((server!.address() as { port: number }).port))
    )
    expect(await hostPortListening(port)).toBe(true)
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
    expect(await hostPortListening(port)).toBe(false)
  })
})
