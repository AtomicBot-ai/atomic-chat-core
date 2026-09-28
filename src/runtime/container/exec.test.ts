import { describe, expect, it } from 'vitest'
import { createDockerExec, runDockerCommand } from './exec.js'

// Same fake-binary convention as `src/runtime/llamacpp/probe.test.ts` and `src/hardware/probe.test.ts`:
// node itself, running an inline `-e` script, stands in for a real `docker` binary on every platform
// with no shebang/chmod dance. The `--` stops node's own CLI parser from reading a real docker arg
// like `--host` as one of *its* flags; the script then reads the real docker-style args (what
// `argv.ts` built) off `process.argv.slice(1)`, so this exercises the actual spawn — no shell,
// sanitized env, argv passed through unmodified, exit code and both streams captured — against a
// real child process.
const fakeDocker = (script: string) => ({ exe: process.execPath, prefixArgs: ['-e', script, '--'] })

describe('runDockerCommand', () => {
  it('spawns with no shell and passes argv through unmodified', async () => {
    const fake = fakeDocker('console.log(JSON.stringify(process.argv.slice(1))); process.exit(0)')
    const result = await runDockerCommand(fake.exe, [...fake.prefixArgs, '--host', 'unix:///x', 'ps'])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(['--host', 'unix:///x', 'ps'])
  })

  it('captures a non-zero exit code and stderr', async () => {
    const fake = fakeDocker('console.error("no such container: c1"); process.exit(1)')
    const result = await runDockerCommand(fake.exe, [...fake.prefixArgs])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('no such container: c1')
  })

  it('reports a shell metacharacter in an argv value as a literal, inert argument (no shell involved)', async () => {
    const fake = fakeDocker('console.log(JSON.stringify(process.argv.slice(1))); process.exit(0)')
    const hostile = '$(rm -rf /); echo pwned; `id`'
    const result = await runDockerCommand(fake.exe, [...fake.prefixArgs, hostile])
    expect(JSON.parse(result.stdout)).toEqual([hostile])
  })

  it('strips DOCKER_HOST/DOCKER_CONTEXT/DOCKER_CONFIG from the child environment', async () => {
    const fake = fakeDocker(
      'console.log(JSON.stringify({h: process.env.DOCKER_HOST, c: process.env.DOCKER_CONTEXT, f: process.env.DOCKER_CONFIG, kept: process.env.ATOMIC_TEST_KEEP})); process.exit(0)'
    )
    const result = await runDockerCommand(fake.exe, [...fake.prefixArgs], {
      env: {
        ...process.env,
        DOCKER_HOST: 'ssh://elsewhere',
        DOCKER_CONTEXT: 'remote',
        DOCKER_CONFIG: '/tmp/x',
        ATOMIC_TEST_KEEP: 'yes',
      },
    })
    expect(JSON.parse(result.stdout)).toEqual({ h: undefined, c: undefined, f: undefined, kept: 'yes' })
  })

  it('reports code: null and a message, never rejecting, when the binary does not exist', async () => {
    const result = await runDockerCommand('/definitely/not/a/real/docker/binary', ['ps'])
    expect(result.code).toBeNull()
    expect(result.stderr.length).toBeGreaterThan(0)
  })

  it('kills a hung process at the timeout and reports code: null', async () => {
    const fake = fakeDocker('setInterval(() => {}, 1000)')
    const result = await runDockerCommand(fake.exe, [...fake.prefixArgs], { timeoutMs: 100 })
    expect(result.code).toBeNull()
  })

  it('truncates output past maxOutputBytes without hanging the child', async () => {
    const fake = fakeDocker('process.stdout.write("x".repeat(10_000)); process.exit(0)')
    const result = await runDockerCommand(fake.exe, [...fake.prefixArgs], { maxOutputBytes: 10 })
    expect(result.stdout.length).toBe(10)
  })
})

describe('createDockerExec', () => {
  it('runs the configured docker binary with the exact argv given', async () => {
    const fake = fakeDocker('console.log(JSON.stringify(process.argv.slice(1))); process.exit(0)')
    // The `-e <script> --` prefix stands in for "docker" itself in this test; a real caller only
    // ever passes `dockerPath: 'docker'` and the argv `argv.ts` built.
    const exec = createDockerExec({ dockerPath: fake.exe })
    // Mirrors a real argv shape (`withSystemSocket`'s `--host ...` first); a bare `inspect` as the
    // very first post-`--` token would collide with node's own `node inspect` debugger CLI, which
    // real docker argv never produces (it is always preceded by `--host ...`).
    const result = await exec([...fake.prefixArgs, '--host', 'unix:///x', 'container', 'inspect', 'c1'])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(['--host', 'unix:///x', 'container', 'inspect', 'c1'])
  })

  it('defaults to "docker" on PATH when no dockerPath is given', async () => {
    const exec = createDockerExec({ timeoutMs: 50 })
    const result = await exec(['--host', 'unix:///nonexistent', 'ps'])
    // Whether or not this host has a `docker` binary, the call must resolve (never reject) with
    // *some* result: either a real exit code or `code: null` for "not found"/"could not answer".
    expect(typeof result.code === 'number' || result.code === null).toBe(true)
  })
})
