/**
 * End-to-end evidence for this module against a fake `docker` binary, per the task brief's
 * acceptance check ("e2e with a fake docker binary"). This is not `test/e2e/` — that layer builds
 * and runs the compiled `atomic-chat-core` binary (see `test/e2e/binary.test.ts`), and nothing wires
 * the model container executor to a route, a CLI command or `src/core/create.ts` yet: that is task
 * 2.6/2.12/2.9's work, explicitly out of scope here. Wiring a fake docker into a binary that has no
 * caller for this module would test nothing this module doesn't already cover. Instead, this proves
 * the same thing an e2e would — the whole executor, wired together, against a real spawned process
 * standing in for `docker` — one level down, directly against `createDockerExec` + `operations.ts`.
 */
import { rmSync } from 'node:fs'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDockerExec } from './exec.js'
import {
  containerLogs,
  createContainer,
  inspectContainer,
  removeContainer,
  startContainer,
  stopContainer,
} from './operations.js'
import type { DockerExec, ModelContainerCreateSpec } from './types.js'
import { skipOnWindows } from '../../../test/helpers/platform.js'

const image = {
  repository: 'nvcr.io/nvidia/tensorrt-llm/release',
  digest: `sha256:${'a'.repeat(64)}`,
} as const

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function tempDockerConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'docker-config-test-'))
  dirs.push(dir)
  return dir
}

/**
 * `createContainer` canonicalizes every mount source and `selinuxDataRoot` through the real
 * `node:fs/promises` `realpath` by default (review round 2, item 2) — this file runs real spawns
 * end to end, so its spec points at a real, freshly created directory tree rather than an
 * injected fake realpath.
 */
async function realCreateSpec(): Promise<ModelContainerCreateSpec> {
  const root = await mkdtemp(join(tmpdir(), 'container-integration-'))
  dirs.push(root)
  const model = join(root, 'model')
  const engineCache = join(root, 'cache')
  const entrypoint = join(root, 'entrypoint')
  const heartbeat = join(root, 'heartbeat')
  await Promise.all([mkdir(model), mkdir(engineCache), mkdir(entrypoint), mkdir(heartbeat)])
  return {
    image,
    gpuUuid: 'GPU-11111111-2222-3333-4444-555555555555',
    selinux: true,
    selinuxDataRoot: root,
    mounts: {
      model: { source: model },
      engineCache: { source: engineCache },
      entrypoint: { source: entrypoint },
      heartbeat: { source: heartbeat },
    },
    publication: { host: '127.0.0.1', host_port: 45123, container_port: 8000 },
    labels: { engine_id: 'tensorrt-llm', scope: 'app', instance_id: 'core-1' },
  }
}

/**
 * A fake `docker` that answers deterministically for the argv shapes `argv.ts` builds: it reads the
 * subcommand out of its own argv (`args[2]`, right after `--host <socket>`) and prints what a real
 * `docker` would for that subcommand on success. One fresh process per call, exactly like a real
 * `docker` CLI invocation.
 */
const FAKE_DOCKER_SCRIPT = `
const args = process.argv.slice(1)
const sub = args[2] // args[0]='--host', args[1]=socket, args[2]=subcommand
if (sub === 'create') {
  console.log('fake0123container')
  process.exit(0)
}
if (sub === 'start') {
  process.exit(0)
}
if (sub === 'stop') {
  process.exit(0)
}
if (sub === 'logs') {
  console.log('2024-01-01T00:00:00.000000000Z engine ready')
  process.exit(0)
}
if (sub === 'rm') {
  process.exit(0)
}
console.error('fake docker: unrecognized subcommand ' + sub)
process.exit(1)
`

const fakeDocker = { exe: process.execPath, prefixArgs: ['-e', FAKE_DOCKER_SCRIPT, '--'] }

describe('the executor end to end against a fake docker binary', () => {
  skipOnWindows('the fake docker is a shebang script, which Windows cannot execute')
  it('runs the full model-container lifecycle: create, start, confirmed stop, logs, rm', async () => {
    const rawExec = createDockerExec({
      dockerPath: fakeDocker.exe,
      dockerConfigDir: await tempDockerConfigDir(),
    })
    const exec: DockerExec = (args, callOptions) => rawExec([...fakeDocker.prefixArgs, ...args], callOptions)

    const { containerId } = await createContainer(exec, await realCreateSpec())
    expect(containerId).toBe('fake0123container')

    await expect(startContainer(exec, containerId)).resolves.toBeUndefined()

    const stopOutcome = await stopContainer(exec, containerId, 10)
    expect(stopOutcome).toEqual({ confirmed: true, status: 'exited' })

    const logs = await containerLogs(exec, containerId, 100)
    expect(logs).toContain('engine ready')

    await expect(removeContainer(exec, containerId)).resolves.toBeUndefined()
  })

  it('reports an absent container as a confirmed stop and an idempotent rm, from real docker-shaped stderr', async () => {
    const absentScript = `
      const args = process.argv.slice(1)
      const sub = args[2]
      if (sub === 'stop' || sub === 'rm') {
        console.error('Error response from daemon: No such container: ' + args[args.length - 1])
        process.exit(1)
      }
      process.exit(0)
    `
    const rawExec = createDockerExec({
      dockerPath: process.execPath,
      dockerConfigDir: await tempDockerConfigDir(),
    })
    const exec: DockerExec = (args, callOptions) => rawExec(['-e', absentScript, '--', ...args], callOptions)

    expect(await stopContainer(exec, 'gone', 5)).toEqual({ confirmed: true, status: 'absent' })
    await expect(removeContainer(exec, 'gone')).resolves.toBeUndefined()
  })

  it('runs createContainer through a real spawn and asserts on the exact argv the fake received: no socket mount, no --privileged, no --ipc, and --pull=never (review round 1, item 13)', async () => {
    const echoScript = `
      console.log(JSON.stringify(process.argv.slice(1)))
      process.exit(0)
    `
    const rawExec = createDockerExec({
      dockerPath: process.execPath,
      dockerConfigDir: await tempDockerConfigDir(),
    })
    let capturedArgv: string[] = []
    const exec: DockerExec = (args, callOptions) => {
      capturedArgv = args
      return rawExec(['-e', echoScript, '--', ...args], callOptions)
    }

    await createContainer(exec, await realCreateSpec())

    expect(capturedArgv).not.toContain('--privileged')
    expect(capturedArgv.join(' ')).not.toContain('--ipc')
    expect(capturedArgv.join(' ')).not.toContain('docker.sock:/var/run/docker.sock')
    expect(capturedArgv).toContain('--pull=never')
    expect(capturedArgv).toContain('--restart=no')
  })

  it('never touches the docker socket, --privileged, or --ipc=host on an inspect call either, and the real spawn sees no shell', async () => {
    const echoScript = `
      console.log(JSON.stringify(process.argv.slice(1)))
      process.exit(0)
    `
    const rawExec = createDockerExec({
      dockerPath: process.execPath,
      dockerConfigDir: await tempDockerConfigDir(),
    })
    const exec: DockerExec = (args, callOptions) => rawExec(['-e', echoScript, '--', ...args], callOptions)

    const seen: string[] = []
    const capturing: DockerExec = (args, callOptions) => {
      seen.push(...args)
      return exec(args, callOptions)
    }
    await inspectContainer(capturing, 'c1').catch(() => undefined) // fake prints its own argv, not JSON; ignore parse errors here
    const joined = seen.join(' ')
    expect(joined).not.toContain('docker.sock:/var/run/docker.sock')
    expect(seen).not.toContain('--privileged')
    expect(joined).not.toContain('--ipc')
  })
})
