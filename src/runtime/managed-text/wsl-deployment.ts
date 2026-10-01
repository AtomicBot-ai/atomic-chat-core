/**
 * The Windows `ManagedDeployment` (change `add-tensorrt-llm-windows`, task 2.7, design D7): the
 * model container runs in Atomic Chat's WSL distribution and publishes its port on the guest's
 * `127.0.0.1` with a port Docker picks there (`127.0.0.1::<container port>`) — a port free on Windows'
 * loopback says nothing about the guest's — read back with `docker port`. Windows reaches it through
 * WSL's localhost forwarding, which is checked rather than assumed: the lifecycle asks the engine
 * inside the guest too (`probeInGuest`), and when only that answers, `diagnoseForwarding` tells a
 * Windows program holding the same port (worth one new publication) from no forwarding at all (the
 * user's `.wslconfig`, explained by `forwardingError`). Mount sources are the guest's own paths
 * (`wslMountSourceResolver`). Never `0.0.0.0` and never the guest's own IP: the engine has no
 * authentication of its own, so it stays on loopback.
 */
import { connect } from 'node:net'
import type { AtomicCoreError } from '../../contracts/index.js'
import { publishedHostPort, type DockerExec } from '../container/index.js'
import type { ManagedReadinessProbe } from './adapter.js'
import { projectSessionPort } from './backend-target.js'
import { wslMountSourceResolver } from './mount-source.js'
import type { ReadinessOutcome } from './readiness.js'
import type { BackendTarget, ManagedDeployment } from './types.js'

const LOOPBACK = '127.0.0.1'
const GUEST_PROBE_SECONDS = 2

export interface WslManagedDeploymentDeps {
  distribution: string
  /** The guest's docker CLI (`guestDockerExec`). */
  exec: DockerExec
  /** One argv in the guest as root (`curl` to the engine's port). */
  runInGuest: (argv: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>
  /** Whether anything accepts a connection on Windows' `127.0.0.1:<port>`; `hostPortListening` in production. */
  hostPortListening?: (port: number) => Promise<boolean>
  /** The load's error for a broken forwarding, with the user's `.wslconfig` in it (`localhostForwardingError`). */
  forwardingError: () => AtomicCoreError | Promise<AtomicCoreError>
}

/** Whether something on this machine accepts a TCP connection on `127.0.0.1:<port>` within a second. */
export function hostPortListening(port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: LOOPBACK, port })
    const done = (listening: boolean): void => {
      socket.destroy()
      resolve(listening)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

export function createWslManagedDeployment(deps: WslManagedDeploymentDeps): ManagedDeployment {
  const mountSource = wslMountSourceResolver(deps.distribution)
  const listening = deps.hostPortListening ?? hostPortListening
  return {
    mountSource,
    prepareLaunch: async (spec, heartbeatCorePath) => ({
      publication: { host: LOOPBACK, host_port: 0, container_port: spec.container_port },
      // Not reachable until `resolveTarget` learns the port Docker chose.
      target: { base_url: `http://${LOOPBACK}:0` },
      heartbeat: { core_path: heartbeatCorePath, mount_source: mountSource(heartbeatCorePath) },
    }),
    resolveTarget: async (containerId, prepared) => {
      const port = await publishedHostPort(deps.exec, containerId, prepared.publication.container_port)
      return {
        ...prepared,
        publication: { ...prepared.publication, host_port: port },
        target: { base_url: `http://${LOOPBACK}:${port}` },
      }
    },
    probeInGuest: async (target: BackendTarget, probe: ManagedReadinessProbe): Promise<ReadinessOutcome> => {
      const url = new URL(probe.path, `http://${LOOPBACK}:${projectSessionPort(target)}`).toString()
      const answer = await deps.runInGuest([
        'curl',
        '--silent',
        '--output',
        '/dev/null',
        '--write-out',
        '%{http_code}',
        '--max-time',
        String(GUEST_PROBE_SECONDS),
        url,
      ])
      return answer.stdout.trim() === String(probe.expectedStatus) ? 'ready' : 'not-ready'
    },
    diagnoseForwarding: async (target) =>
      (await listening(projectSessionPort(target))) ? 'port-taken' : 'not-forwarded',
    forwardingError: deps.forwardingError,
  }
}
