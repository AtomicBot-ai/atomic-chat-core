import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import { projectSessionPort } from './backend-target.js'
import { createDesktopManagedDeployment } from './deployment.js'
import type { EngineLaunchSpec, ManagedDeployment, PreparedLaunch } from './types.js'

const SPEC: EngineLaunchSpec = { container_port: 8000 }

/** T24a-style fake: a deployment that reaches its engine by a non-loopback address (e.g. a future
 *  sibling-container topology), to prove the desktop session projection still refuses it. */
function fakeNonLoopbackDeployment(): ManagedDeployment {
  return {
    mountSource: (corePath) => `/mnt/fake${corePath}`,
    async prepareLaunch(spec, heartbeatCorePath): Promise<PreparedLaunch> {
      return {
        publication: { host: '10.0.0.5', host_port: 9000, container_port: spec.container_port },
        target: { base_url: 'http://10.0.0.5:9000' },
        heartbeat: { core_path: heartbeatCorePath, mount_source: `/mnt/fake${heartbeatCorePath}` },
      }
    },
  }
}

describe('a fake deployment with a non-loopback target', () => {
  it('prepares a launch, but its target is refused by the desktop session projection', async () => {
    const deployment = fakeNonLoopbackDeployment()
    const prepared = await deployment.prepareLaunch(SPEC, '/data/session-1/heartbeat')

    expect(prepared.target.base_url).toBe('http://10.0.0.5:9000')
    expect(() => projectSessionPort(prepared.target)).toThrow(AtomicCoreError)
    try {
      projectSessionPort(prepared.target)
      expect.unreachable()
    } catch (error) {
      expect((error as AtomicCoreError).code).toBe('FORBIDDEN_HOST')
    }
  })
})

describe('createDesktopManagedDeployment', () => {
  it('publishes on loopback with the injected host port and projects to that port', async () => {
    const deployment = createDesktopManagedDeployment({
      allocateHostPort: async () => 34521,
    })

    const prepared = await deployment.prepareLaunch(SPEC, '/data/session-1/heartbeat')

    expect(prepared.publication).toEqual({
      host: '127.0.0.1',
      host_port: 34521,
      container_port: 8000,
    })
    expect(prepared.target).toEqual({ base_url: 'http://127.0.0.1:34521' })
    expect(projectSessionPort(prepared.target)).toBe(34521)
  })

  it('resolves the heartbeat bind through the injected MountSourceResolver', async () => {
    const deployment = createDesktopManagedDeployment({
      allocateHostPort: async () => 34521,
      mountSource: (corePath) => `/mnt/wsl${corePath}`,
    })

    const prepared = await deployment.prepareLaunch(SPEC, '/data/session-1/heartbeat')

    expect(prepared.heartbeat).toEqual({
      core_path: '/data/session-1/heartbeat',
      mount_source: '/mnt/wsl/data/session-1/heartbeat',
    })
    // The same resolver serves every other mount the lifecycle makes (review round 1, ruling 4).
    expect(deployment.mountSource('/data/llamacpp/models/m')).toBe('/mnt/wsl/data/llamacpp/models/m')
  })

  it('defaults the heartbeat mount source to identity', async () => {
    const deployment = createDesktopManagedDeployment({ allocateHostPort: async () => 34521 })

    const prepared = await deployment.prepareLaunch(SPEC, '/data/session-1/heartbeat')

    expect(prepared.heartbeat).toEqual({
      core_path: '/data/session-1/heartbeat',
      mount_source: '/data/session-1/heartbeat',
    })
    expect(deployment.mountSource('/data/cache')).toBe('/data/cache')
  })

  it('passes the host ports already in use to the port allocator', async () => {
    const seen: number[][] = []
    const deployment = createDesktopManagedDeployment({
      usedHostPorts: () => [3001, 3002],
      allocateHostPort: async (used) => {
        seen.push([...used])
        return 3003
      },
    })

    await deployment.prepareLaunch(SPEC, '/data/session-1/heartbeat')

    expect(seen).toEqual([[3001, 3002]])
  })

  it('allocates a real free loopback port with no injected allocator (production default)', async () => {
    const deployment = createDesktopManagedDeployment()

    const prepared = await deployment.prepareLaunch(SPEC, '/data/session-1/heartbeat')

    expect(prepared.publication.host).toBe('127.0.0.1')
    expect(Number.isInteger(prepared.publication.host_port)).toBe(true)
    expect(projectSessionPort(prepared.target)).toBe(prepared.publication.host_port)
  })
})
