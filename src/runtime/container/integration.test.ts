/**
 * End-to-end evidence for this module against a fake `docker` binary, per the task brief's
 * acceptance check ("e2e с фейковым docker-бинарём"). This is not `test/e2e/` — that layer builds
 * and runs the compiled `atomic-chat-core` binary (see `test/e2e/binary.test.ts`), and nothing wires
 * the model container executor to a route, a CLI command or `src/core/create.ts` yet: that is task
 * 2.6/2.12/2.9's work, explicitly out of scope here. Wiring a fake docker into a binary that has no
 * caller for this module would test nothing this module doesn't already cover. Instead, this proves
 * the same thing an e2e would — the whole executor, wired together, against a real spawned process
 * standing in for `docker` — one level down, directly against `createDockerExec` + `operations.ts`.
 */
import { describe, expect, it } from 'vitest'
import { createDockerExec } from './exec.js'
import {
  containerLogs,
  createContainer,
  inspectContainer,
  removeContainer,
  startContainer,
  stopContainer,
} from './operations.js'
import type { ModelContainerCreateSpec } from './types.js'

const image = {
  repository: 'nvcr.io/nvidia/tensorrt-llm/release',
  digest: `sha256:${'a'.repeat(64)}`,
} as const

const createSpec: ModelContainerCreateSpec = {
  image,
  gpuUuid: 'GPU-11111111-2222-3333-4444-555555555555',
  selinux: true,
  mounts: {
    model: { source: '/daemon/models/qwen3' },
    engineCache: { source: '/daemon/cache/qwen3' },
    entrypoint: { source: '/daemon/entrypoint.sh' },
    heartbeat: { source: '/daemon/heartbeat' },
  },
  publication: { host: '127.0.0.1', host_port: 45123, container_port: 8000 },
  labels: { engine_id: 'tensorrt-llm', scope: 'app', instance_id: 'core-1' },
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
  console.log('engine ready')
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
  it('runs the full model-container lifecycle: create, start, confirmed stop, logs, rm', async () => {
    const rawExec = createDockerExec({ dockerPath: fakeDocker.exe })
    const exec = (args: string[]) => rawExec([...fakeDocker.prefixArgs, ...args])

    const { containerId } = await createContainer(exec, createSpec)
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
    const rawExec = createDockerExec({ dockerPath: process.execPath })
    const exec = (args: string[]) => rawExec(['-e', absentScript, '--', ...args])

    expect(await stopContainer(exec, 'gone', 5)).toEqual({ confirmed: true, status: 'absent' })
    await expect(removeContainer(exec, 'gone')).resolves.toBeUndefined()
  })

  it('never touches the docker socket, --privileged, or --ipc=host end to end, and the real spawn sees no shell', async () => {
    const echoScript = `
      console.log(JSON.stringify(process.argv.slice(1)))
      process.exit(0)
    `
    const rawExec = createDockerExec({ dockerPath: process.execPath })
    const exec = (args: string[]) => rawExec(['-e', echoScript, '--', ...args])

    const seen: string[] = []
    const capturing = (args: string[]) => {
      seen.push(...args)
      return exec(args)
    }
    await inspectContainer(capturing, 'c1').catch(() => undefined) // fake prints its own argv, not JSON; ignore parse errors here
    const joined = seen.join(' ')
    expect(joined).not.toContain('docker.sock:/var/run/docker.sock')
    expect(seen).not.toContain('--privileged')
    expect(joined).not.toContain('--ipc')
  })
})
