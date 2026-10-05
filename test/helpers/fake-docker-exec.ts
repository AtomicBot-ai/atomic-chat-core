/**
 * An in-process stand-in for the `docker` CLI behind a `DockerExec` (`src/runtime/container/`): it
 * reads the argv `argv.ts` builds and keeps a small container table, so a managed-text lifecycle test
 * can script a container that starts, logs, exits early, or refuses to confirm a stop — without a
 * spawned process per call. `src/runtime/managed-text/lifecycle.integration.test.ts` covers the same
 * lifecycle against a real spawned fake binary.
 */
import type { DockerCommandResult, DockerExec } from '../../src/runtime/container/index.js'

export interface FakeContainer {
  id: string
  /** The full `docker create` argv (after `--host <socket>`). */
  createArgv: string[]
  status: 'created' | 'running' | 'exited'
  exitCode: number | null
  logs: string[]
}

const ok = (stdout = ''): DockerCommandResult => ({ code: 0, stdout, stderr: '' })
const noSuch = (id: string): DockerCommandResult => ({
  code: 1,
  stdout: '',
  stderr: `Error response from daemon: No such container: ${id}`,
})

export class FakeDocker {
  readonly containers = new Map<string, FakeContainer>()
  /** Every argv this fake received, without the leading `--host <socket>`. */
  readonly calls: string[][] = []
  /** stderr for the next `docker start` calls to fail with, consumed one per start. */
  startFailures: string[] = []
  /** When false, `docker stop` never answers (the exec's own deadline), so the stop is unconfirmed. */
  stopConfirms = true
  /** When true, `docker rm` fails with a daemon error the executor cannot classify. */
  rmFails = false
  /** Lines every newly started container logs at once. */
  bootLog: string[] = []
  private next = 0
  private tick = 0

  /** While set, every `docker stop` waits for it before answering (a slow daemon, a long `--time`). */
  stopGate: Promise<void> | undefined

  readonly exec: DockerExec = async (args) => {
    if (args[2] === 'stop' && this.stopGate) await this.stopGate
    return this.run(args.slice(2))
  }

  /** The container created most recently. */
  last(): FakeContainer {
    const all = [...this.containers.values()]
    const last = all[all.length - 1]
    if (!last) throw new Error('fake docker: nothing created yet')
    return last
  }

  log(id: string, line: string): void {
    this.containers.get(id)?.logs.push(this.stamp(line))
  }

  /** The engine inside exits on its own, the way a crash or an OOM ends a container. */
  exit(id: string, code: number, lines: string[] = []): void {
    const c = this.containers.get(id)
    if (!c) return
    for (const line of lines) c.logs.push(this.stamp(line))
    c.status = 'exited'
    c.exitCode = code
  }

  subcommands(): string[] {
    return this.calls.map((argv) => (argv[0] === 'container' ? `container ${argv[1]}` : (argv[0] ?? '')))
  }

  private stamp(line: string): string {
    this.tick += 1
    return `2026-09-28T10:00:${String(this.tick).padStart(2, '0')}.000000000Z ${line}`
  }

  private run(argv: string[]): DockerCommandResult {
    this.calls.push(argv)
    const sub = argv[0]
    const id = argv[argv.length - 1] ?? ''
    const c = this.containers.get(id)
    switch (sub) {
      case 'create': {
        this.next += 1
        const created: FakeContainer = {
          id: `fakecontainer${this.next}`,
          createArgv: argv,
          status: 'created',
          exitCode: null,
          logs: [],
        }
        this.containers.set(created.id, created)
        return ok(`${created.id}\n`)
      }
      case 'start': {
        if (!c) return noSuch(id)
        const failure = this.startFailures.shift()
        if (failure !== undefined) return { code: 1, stdout: '', stderr: failure }
        c.status = 'running'
        for (const line of this.bootLog) c.logs.push(this.stamp(line))
        return ok(`${id}\n`)
      }
      case 'container': {
        if (argv[1] !== 'inspect') break
        if (!c) return noSuch(id)
        const state = {
          Status: c.status,
          Running: c.status === 'running',
          ExitCode: c.exitCode ?? 0,
        }
        return ok(JSON.stringify([{ Id: c.id, State: state }]))
      }
      case 'stop': {
        if (!this.stopConfirms)
          return { code: null, stdout: '', stderr: 'docker did not answer within 15000 ms' }
        if (!c) return noSuch(id)
        if (c.status === 'running') {
          c.status = 'exited'
          c.exitCode = 143
        }
        return ok(`${id}\n`)
      }
      case 'rm': {
        if (this.rmFails)
          return { code: 1, stdout: '', stderr: 'Error response from daemon: device or resource busy' }
        if (!c) return noSuch(id)
        this.containers.delete(id)
        return ok(`${id}\n`)
      }
      case 'logs': {
        if (!c) return noSuch(id)
        const count = argv[argv.indexOf('--tail') + 1]
        const lines = count === 'all' ? c.logs : c.logs.slice(-Number(count))
        return ok(lines.join('\n') + (c.logs.length > 0 ? '\n' : ''))
      }
    }
    return { code: 1, stdout: '', stderr: `fake docker: unsupported ${argv.join(' ')}` }
  }
}
