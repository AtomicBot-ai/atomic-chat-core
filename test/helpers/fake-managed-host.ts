/**
 * A fake Linux machine for the compiled core's managed-runtime e2e (task 2.6): the folder
 * `ATOMIC_MANAGED_TEST_HOST` names (see `src/runtime/environment/linux-host.ts`), with one
 * `bin/<command>` wrapper per probe command around `fake-linux-host.mjs`, `root/etc/os-release`,
 * `free-disk-bytes`, and a fake Docker Engine API on `docker.sock` that streams byte progress for
 * an image pull and records every pull. `runHostStep` is the fake privileged executor: it changes
 * the machine the way the recipe would (or not at all) and hands back the receipt a client posts.
 *
 * Nothing here imports from `src/`: the e2e suite drives the binary only through its routes.
 */
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FakeLinuxHostState } from './fake-linux-host.mjs'
import { readLinuxProbeFixture } from './linux-probe-fixtures.js'

const FAKE_HOST = fileURLToPath(new URL('./fake-linux-host.mjs', import.meta.url))
export const DESCRIPTOR_URL = new URL('../fixtures/runtimes/tensorrt-llm.json', import.meta.url).href
const DESCRIPTOR = JSON.parse(readFileSync(fileURLToPath(DESCRIPTOR_URL), 'utf8')) as {
  descriptor_id: string
  image: Record<string, { repository: string; digest: string }>
  probe_image: Record<string, { repository: string; digest: string }>
}
export const DESCRIPTOR_ID = DESCRIPTOR.descriptor_id
export const ENGINE_IMAGE = `${DESCRIPTOR.image['linux/amd64']!.repository}@${DESCRIPTOR.image['linux/amd64']!.digest}`
export const PROBE_IMAGE = `${DESCRIPTOR.probe_image['linux/amd64']!.repository}@${DESCRIPTOR.probe_image['linux/amd64']!.digest}`
export const GPU_UUID = 'GPU-0b6f4f4e-6c1c-3a54-8f2d-1b0d2f4d6a11'

const COMMANDS = [
  'uname',
  'nvidia-smi',
  'docker',
  'nvidia-ctk',
  'dpkg-query',
  'rpm',
  'pacman',
  'snap',
  'id',
  'getent',
  'systemctl',
]

/** A ready Ubuntu 24.04 desktop with an RTX 4090, Docker and the NVIDIA runtime, the user in `docker`. */
export const readyState = (): FakeLinuxHostState => ({
  driver: '590.44.01',
  gpus: [{ uuid: GPU_UUID, name: 'NVIDIA GeForce RTX 4090', cc: '8.9', total_mib: 24564, free_mib: 24000 }],
  docker: { installed: true, reachable: true, service_active: true, gpu_runtime: true },
  toolkit: true,
  group: { configured: true, effective: true },
  gpu_visible_in_container: true,
  images: [],
  containers: [],
})

/** The same machine with the driver only: no Docker, no toolkit, not in the group. */
export const cleanState = (): FakeLinuxHostState => ({
  ...readyState(),
  docker: { installed: false, reachable: false, service_active: false, gpu_runtime: false },
  toolkit: false,
  group: { configured: false, effective: false },
})

export interface PendingHostStep {
  step_id: string
  nonce: string
  expected_operation_revision: number
  recipe_digest: string
  parameters_digest: string
  parameters: { user: string; components: string[] }
}

export interface FakeManagedHost {
  dir: string
  env: Record<string, string>
  state(): FakeLinuxHostState
  update(change: (state: FakeLinuxHostState) => FakeLinuxHostState): void
  /** Every probe or docker command the core ran, oldest first. */
  calls(): string[][]
  /** Every image pull the Engine API received, as `repository@digest`. */
  pulls: string[]
  /** While true, an engine image pull sends one progress line and then never finishes. */
  holdEnginePull: boolean
  setFreeDisk(bytes: number): void
  /**
   * The privileged executor: `completed` applies every component the step asks for (and leaves the
   * group granted but not yet effective in this session), `none` pretends and changes nothing.
   */
  runHostStep(
    step: PendingHostStep,
    outcome: 'completed' | 'declined',
    apply?: 'all' | 'none'
  ): Record<string, unknown>
  close(): Promise<void>
}

export async function fakeManagedHost(initial: FakeLinuxHostState): Promise<FakeManagedHost> {
  // Short: the Engine API is a unix socket inside it, and macOS caps those paths at 104 bytes.
  const dir = await mkdtemp(join(tmpdir(), 'amh-'))
  const statePath = join(dir, 'state.json')
  mkdirSync(join(dir, 'bin'))
  mkdirSync(join(dir, 'root', 'etc', 'docker'), { recursive: true })
  writeFileSync(join(dir, 'root', 'etc', 'os-release'), readLinuxProbeFixture('os-release/ubuntu-24.04.txt'))
  writeFileSync(join(dir, 'free-disk-bytes'), String(500 * 1024 ** 3))
  for (const command of COMMANDS) {
    const wrapper = join(dir, 'bin', command)
    writeFileSync(
      wrapper,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_HOST)} ${JSON.stringify(statePath)} ${command} "$@"\n`
    )
    chmodSync(wrapper, 0o755)
  }

  const read = (): FakeLinuxHostState => JSON.parse(readFileSync(statePath, 'utf8')) as FakeLinuxHostState
  const write = (state: FakeLinuxHostState): void => {
    writeFileSync(`${statePath}.tmp`, JSON.stringify(state, null, 2))
    renameSync(`${statePath}.tmp`, statePath)
    // `nvidia-ctk runtime configure` leaves this behind; it is all a probe sees while the daemon is out of reach.
    const daemonJson = join(dir, 'root', 'etc', 'docker', 'daemon.json')
    if (state.docker.gpu_runtime)
      writeFileSync(
        daemonJson,
        JSON.stringify({ runtimes: { nvidia: { path: 'nvidia-container-runtime' } } })
      )
  }
  write(initial)

  const host: FakeManagedHost = {
    dir,
    env: {
      ATOMIC_MANAGED_TEST_HOST: dir,
      ATOMIC_RUNTIME_DESCRIPTOR_URL: DESCRIPTOR_URL,
    },
    state: read,
    update: (change) => write(change(read())),
    calls: () =>
      existsSync(`${statePath}.calls`)
        ? readFileSync(`${statePath}.calls`, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as string[])
        : [],
    pulls: [],
    holdEnginePull: false,
    setFreeDisk: (bytes) => writeFileSync(join(dir, 'free-disk-bytes'), String(bytes)),
    runHostStep: (step, outcome, apply = 'all') => {
      appendFileSync(
        `${statePath}.calls`,
        `${JSON.stringify(['host-step', outcome, apply, ...step.parameters.components])}\n`
      )
      if (outcome === 'completed' && apply === 'all') {
        const components = step.parameters.components
        host.update((state) => ({
          ...state,
          docker: {
            ...state.docker,
            installed: state.docker.installed || components.includes('docker-engine'),
            service_active: state.docker.service_active || components.includes('docker-service'),
            gpu_runtime: state.docker.gpu_runtime || components.includes('nvidia-runtime'),
            // Granted, not yet in this session: the daemon still refuses until the user signs in again.
            reachable: state.docker.reachable && !components.includes('docker-group'),
          },
          toolkit: state.toolkit || components.includes('nvidia-container-toolkit'),
          group: components.includes('docker-group')
            ? { configured: true, effective: false }
            : (state.group ?? { configured: false, effective: false }),
        }))
      }
      return {
        step_id: step.step_id,
        nonce: step.nonce,
        expected_operation_revision: step.expected_operation_revision,
        recipe_digest: step.recipe_digest,
        parameters_digest: step.parameters_digest,
        outcome,
        receipt_id: `receipt-${step.nonce}`,
      }
    },
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }

  // The Docker Engine API's pull: one JSON progress line per layer tick, then the image exists.
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://engine')
    if (req.method !== 'POST' || !url.pathname.endsWith('/images/create')) {
      res.writeHead(404).end()
      return
    }
    const ref = `${url.searchParams.get('fromImage')}@${url.searchParams.get('tag')}`
    host.pulls.push(ref)
    res.writeHead(200, { 'content-type': 'application/json' })
    const line = (current: number) =>
      res.write(
        `${JSON.stringify({ status: 'Downloading', id: 'layer-1', progressDetail: { current, total: 4_000_000 } })}\n`
      )
    line(1_000_000)
    if (ref === ENGINE_IMAGE && host.holdEnginePull) return // the core dies with this pull in flight
    setTimeout(() => line(2_000_000), 300)
    setTimeout(() => {
      line(4_000_000)
      host.update((state) => ({ ...state, images: [...new Set([...(state.images ?? []), ref])] }))
      res.end(`${JSON.stringify({ status: `Digest: ${ref.split('@')[1]}` })}\n`)
    }, 600)
  })
  await new Promise<void>((resolve) => server.listen(join(dir, 'docker.sock'), resolve))
  return host
}
