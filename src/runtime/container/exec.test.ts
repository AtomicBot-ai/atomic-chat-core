import { existsSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDockerExec, runDockerCommand } from './exec.js'

// Same fake-binary convention as `src/runtime/llamacpp/probe.test.ts` and `src/hardware/probe.test.ts`:
// node itself, running an inline `-e` script, stands in for a real `docker` binary on every platform
// with no shebang/chmod dance. The `--` stops node's own CLI parser from reading a real docker arg
// like `--host` as one of *its* flags; the script then reads the real docker-style args (what
// `argv.ts` built) off `process.argv.slice(1)`, so this exercises the actual spawn — no shell,
// sanitized env, argv passed through unmodified, exit code and both streams captured — against a
// real child process.
const fakeDocker = (script: string) => ({ exe: process.execPath, prefixArgs: ['-e', script, '--'] })

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function tempDockerConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'docker-config-test-'))
  dirs.push(dir)
  return dir
}

describe('runDockerCommand', () => {
  it('spawns with no shell and passes argv through unmodified', async () => {
    const fake = fakeDocker('console.log(JSON.stringify(process.argv.slice(1))); process.exit(0)')
    const result = await runDockerCommand(fake.exe, [...fake.prefixArgs, '--host', 'unix:///x', 'ps'], {
      dockerConfigDir: await tempDockerConfigDir(),
    })
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(['--host', 'unix:///x', 'ps'])
  })

  it('captures a non-zero exit code and stderr', async () => {
    const fake = fakeDocker('console.error("no such container: c1"); process.exit(1)')
    const result = await runDockerCommand(fake.exe, [...fake.prefixArgs], {
      dockerConfigDir: await tempDockerConfigDir(),
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('no such container: c1')
  })

  it('reports a shell metacharacter in an argv value as a literal, inert argument (no shell involved)', async () => {
    const fake = fakeDocker('console.log(JSON.stringify(process.argv.slice(1))); process.exit(0)')
    const hostile = '$(rm -rf /); echo pwned; `id`'
    const result = await runDockerCommand(fake.exe, [...fake.prefixArgs, hostile], {
      dockerConfigDir: await tempDockerConfigDir(),
    })
    expect(JSON.parse(result.stdout)).toEqual([hostile])
  })

  it('strips DOCKER_HOST/DOCKER_CONTEXT from the child environment', async () => {
    const fake = fakeDocker(
      'console.log(JSON.stringify({h: process.env.DOCKER_HOST, c: process.env.DOCKER_CONTEXT, kept: process.env.ATOMIC_TEST_KEEP})); process.exit(0)'
    )
    const result = await runDockerCommand(fake.exe, [...fake.prefixArgs], {
      dockerConfigDir: await tempDockerConfigDir(),
      env: {
        ...process.env,
        DOCKER_HOST: 'ssh://elsewhere',
        DOCKER_CONTEXT: 'remote',
        ATOMIC_TEST_KEEP: 'yes',
      },
    })
    expect(JSON.parse(result.stdout)).toEqual({ h: undefined, c: undefined, kept: 'yes' })
  })

  it('points DOCKER_CONFIG at the given directory, and creates it if missing (review round 1, item 5 ruling)', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'docker-config-test-'))
    dirs.push(parent)
    const dockerConfigDir = join(parent, 'not-yet-created')
    expect(existsSync(dockerConfigDir)).toBe(false)
    const fake = fakeDocker('console.log(JSON.stringify(process.env.DOCKER_CONFIG)); process.exit(0)')
    const result = await runDockerCommand(fake.exe, [...fake.prefixArgs], { dockerConfigDir })
    expect(JSON.parse(result.stdout)).toBe(dockerConfigDir)
    expect(existsSync(dockerConfigDir)).toBe(true)
  })

  it('reports code: null and a message, never rejecting, when the binary does not exist', async () => {
    const result = await runDockerCommand('/definitely/not/a/real/docker/binary', ['ps'], {
      dockerConfigDir: await tempDockerConfigDir(),
    })
    expect(result.code).toBeNull()
    expect(result.stderr.length).toBeGreaterThan(0)
  })

  it('kills a hung process at the timeout and reports code: null', async () => {
    const fake = fakeDocker('setInterval(() => {}, 1000)')
    const result = await runDockerCommand(fake.exe, [...fake.prefixArgs], {
      dockerConfigDir: await tempDockerConfigDir(),
      timeoutMs: 100,
    })
    expect(result.code).toBeNull()
  })

  it('truncates output past maxOutputBytes without hanging the child', async () => {
    const fake = fakeDocker('process.stdout.write("x".repeat(10_000)); process.exit(0)')
    const result = await runDockerCommand(fake.exe, [...fake.prefixArgs], {
      dockerConfigDir: await tempDockerConfigDir(),
      maxOutputBytes: 10,
    })
    expect(result.stdout.length).toBe(10)
  })

  it('lets a per-call timeoutMs override the options default (review round 1, item 3)', async () => {
    const fake = fakeDocker('setInterval(() => {}, 1000)')
    const start = Date.now()
    const result = await runDockerCommand(
      fake.exe,
      [...fake.prefixArgs],
      { dockerConfigDir: await tempDockerConfigDir(), timeoutMs: 5_000 },
      { timeoutMs: 100 }
    )
    expect(result.code).toBeNull()
    expect(Date.now() - start).toBeLessThan(2_000)
  })
})

describe('createDockerExec', () => {
  it('runs the configured docker binary with the exact argv given', async () => {
    const fake = fakeDocker('console.log(JSON.stringify(process.argv.slice(1))); process.exit(0)')
    // The `-e <script> --` prefix stands in for "docker" itself in this test; a real caller only
    // ever passes `dockerPath: 'docker'` and the argv `argv.ts` built.
    const exec = createDockerExec({ dockerPath: fake.exe, dockerConfigDir: await tempDockerConfigDir() })
    // Mirrors a real argv shape (`withSystemSocket`'s `--host ...` first); a bare `inspect` as the
    // very first post-`--` token would collide with node's own `node inspect` debugger CLI, which
    // real docker argv never produces (it is always preceded by `--host ...`).
    const result = await exec([...fake.prefixArgs, '--host', 'unix:///x', 'container', 'inspect', 'c1'])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(['--host', 'unix:///x', 'container', 'inspect', 'c1'])
  })

  it('passes a per-call DockerExecCallOptions through to runDockerCommand', async () => {
    const fake = fakeDocker('setInterval(() => {}, 1000)')
    const exec = createDockerExec({
      dockerPath: fake.exe,
      dockerConfigDir: await tempDockerConfigDir(),
      timeoutMs: 5_000,
    })
    const start = Date.now()
    const result = await exec([...fake.prefixArgs], { timeoutMs: 100 })
    expect(result.code).toBeNull()
    expect(Date.now() - start).toBeLessThan(2_000)
  })

  it('defaults to the literal "docker" binary when no dockerPath is given (review round 1, item 14: a meaningful assertion)', async () => {
    // Force ENOENT by clearing PATH, so the spawn's own error names the executable it tried to run —
    // this is what actually proves the default is "docker" and not some other fallback, rather than
    // the previous version's assertion that only checked `result.code`'s type, which was true for
    // any outcome at all.
    const exec = createDockerExec({
      dockerConfigDir: await tempDockerConfigDir(),
      timeoutMs: 2_000,
      env: { ...process.env, PATH: '' },
    })
    const result = await exec(['--host', 'unix:///nonexistent', 'ps'])
    expect(result.code).toBeNull()
    expect(result.stderr).toContain('docker')
  })
})
