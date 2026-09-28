import { describe, expect, it } from 'vitest'
import { hostExec } from './host-exec.js'

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
