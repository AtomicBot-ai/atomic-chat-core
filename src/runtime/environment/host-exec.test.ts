import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { hostExec } from './host-exec.js'
import type { HostExecOptions } from './host-exec.js'

/** A real child process: the point of this module is what spawning actually does. */
const node = process.execPath

describe('running a probe command', () => {
  it('hands back what the command printed and how it exited', async () => {
    const run = hostExec()
    const answered = await run(node, ['-e', 'process.stdout.write("hello"); process.exit(0)'])
    expect(answered).toEqual({ code: 0, stdout: 'hello', stderr: '' })

    const failed = await run(node, ['-e', 'process.stderr.write("no"); process.exit(3)'])
    expect(failed.code).toBe(3)
    expect(failed.stderr).toBe('no')
  })

  it('reports a binary that is not on the machine as unanswered, not as a failure', async () => {
    // The probes read `null` as "unknown", which blocks; a number would be read as "absent".
    const answer = await hostExec()('atomic-no-such-binary-anywhere', ['--version'])
    expect(answer.code).toBeNull()
  })

  it('passes an argument through exactly as written, with no shell to interpret it', async () => {
    const hostile = 'a;echo pwned && $(whoami) `id` | cat > /tmp/x'
    const answer = await hostExec()(node, ['-e', 'process.stdout.write(process.argv[1])', hostile])
    expect(answer.stdout).toBe(hostile)
  })

  it('gives up on a command that hangs, and counts it as unanswered', async () => {
    // A hung `nvidia-smi` is not evidence that there is no driver.
    const answer = await hostExec({ timeoutMs: 200 })(node, ['-e', 'setInterval(() => {}, 1000)'])
    expect(answer.code).toBeNull()
    expect(answer.stderr).toMatch(/timed out/)
  })

  it('with a grace period, asks a hung command to stop and waits for it before answering', async () => {
    // A package manager killed outright can leave dpkg half-configured; SIGTERM lets it stop cleanly.
    const script =
      'process.on("SIGTERM", () => { process.stderr.write("stopping cleanly"); process.exit(0) }); setInterval(() => {}, 1000)'
    const answer = await hostExec({ timeoutMs: 300, terminateGraceMs: 5_000 })(node, ['-e', script])
    expect(answer.code).toBeNull()
    expect(answer.stderr).toMatch(/stopping cleanly/)
    expect(answer.stderr).toMatch(/timed out after 300 ms/)
  })

  it('with a grace period, still kills a command that ignores the request to stop', async () => {
    const script = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'
    const started = Date.now()
    const answer = await hostExec({ timeoutMs: 200, terminateGraceMs: 300 })(node, ['-e', script])
    expect(answer.code).toBeNull()
    expect(answer.stderr).toMatch(/timed out/)
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  it('after the kill, answers even while a grandchild still holds its output open', async () => {
    // `close` waits for every holder of the pipes; a package manager's leftover helper can hold them
    // for as long as it likes. The answer must not wait for it.
    const script = [
      'const { spawn } = require("node:child_process")',
      'spawn(process.execPath, ["-e", "setTimeout(() => {}, 8000)"], { stdio: "inherit" })',
      'process.on("SIGTERM", () => {})',
      'setInterval(() => {}, 1000)',
    ].join(';')
    const started = Date.now()
    const answer = await hostExec({ timeoutMs: 300, terminateGraceMs: 300 })(node, ['-e', script])
    expect(answer.code).toBeNull()
    expect(answer.stderr).toMatch(/timed out after 300 ms/)
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  /**
   * A child that ignores SIGTERM, exits on SIGKILL, and whose pipes never close (a grandchild still
   * holds them), so `close` never fires.
   */
  function childWhosePipesNeverClose() {
    const emitter = new EventEmitter()
    const signals: string[] = []
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = Object.assign(emitter, {
      stdout,
      stderr,
      kill: (signal: string) => {
        signals.push(signal)
        if (signal === 'SIGKILL') setImmediate(() => emitter.emit('exit', null, 'SIGKILL'))
        return true
      },
    })
    const spawnProcess = (() => child) as unknown as NonNullable<HostExecOptions['spawnProcess']>
    return { signals, stdout, stderr, spawnProcess }
  }

  it('destroys its end of the pipes after answering, so root can exit while a grandchild holds them', async () => {
    const { signals, stdout, stderr, spawnProcess } = childWhosePipesNeverClose()
    const answer = await hostExec({ timeoutMs: 20, terminateGraceMs: 20, spawnProcess })(node, [])
    expect(answer.code).toBeNull()
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(stdout.destroyed).toBe(true)
    expect(stderr.destroyed).toBe(true)
  })

  it('without a grace period too: kills, answers, and releases its end of the pipes', async () => {
    const { signals, stdout, stderr, spawnProcess } = childWhosePipesNeverClose()
    const answer = await hostExec({ timeoutMs: 20, spawnProcess })(node, [])
    expect(answer).toEqual({ code: null, stdout: '', stderr: 'timed out after 20 ms' })
    expect(signals).toEqual(['SIGKILL'])
    expect(stdout.destroyed).toBe(true)
    expect(stderr.destroyed).toBe(true)
  })

  it('keeps no more output than it was allowed to', async () => {
    const answer = await hostExec({ maxOutputBytes: 10 })(node, [
      '-e',
      'process.stdout.write("x".repeat(100000))',
    ])
    expect(answer.code).toBe(0)
    expect(answer.stdout).toHaveLength(10)
  })

  it('runs with the environment it was given, when it was given one', async () => {
    const answer = await hostExec({ env: { ...process.env, ATOMIC_PROBE_MARK: 'seen' } })(node, [
      '-e',
      'process.stdout.write(process.env.ATOMIC_PROBE_MARK ?? "")',
    ])
    expect(answer.stdout).toBe('seen')
  })

  it('overlays a per-call env onto the ambient one rather than replacing it (item 10)', async () => {
    const withMark =
      process.env.PATH !== undefined ? { ...process.env, ATOMIC_PROBE_MARK: 'seen' } : process.env
    const run = hostExec({ env: withMark })
    const readEnv = (name: string) =>
      run(node, ['-e', `process.stdout.write(process.env.${name} ?? "<unset>")`], {
        ATOMIC_PROBE_MARK: undefined,
      })

    // Stripped by the overlay...
    expect((await readEnv('ATOMIC_PROBE_MARK')).stdout).toBe('<unset>')
    // ...but PATH (never mentioned in the overlay) still comes through from the base environment.
    expect((await readEnv('PATH')).stdout).not.toBe('<unset>')
  })

  it('sets a key the overlay maps to a string, on top of the ambient environment', async () => {
    const answer = await hostExec()(
      node,
      ['-e', 'process.stdout.write(process.env.ATOMIC_PROBE_OVERLAY ?? "")'],
      { ATOMIC_PROBE_OVERLAY: 'from-overlay' }
    )
    expect(answer.stdout).toBe('from-overlay')
  })
})
