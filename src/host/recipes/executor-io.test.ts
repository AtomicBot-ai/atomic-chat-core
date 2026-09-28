import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invokingUidFrom, nodeHostStepDeps } from './executor-io.js'
import { INSTALL_CONTAINER_RUNTIME_RECIPE } from './install-container-runtime.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-host-step-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const deps = () => nodeHostStepDeps({})

describe('reading the request as root', () => {
  it('reads a regular file', async () => {
    const path = join(dir, 's.request.json')
    await writeFile(path, '{"a":1}')
    expect(await deps().readRequest(path)).toBe('{"a":1}')
  })

  it('refuses a symlink, so a request cannot point root at another file', async () => {
    const secret = join(dir, 'secret')
    await writeFile(secret, 'root:hash')
    const path = join(dir, 's.request.json')
    await symlink(secret, path)
    await expect(deps().readRequest(path)).rejects.toMatchObject({
      code: expect.stringMatching(/ELOOP|EMLINK/),
    })
  })

  it('refuses a directory and a file too large to be a request', async () => {
    const folder = join(dir, 'd.request.json')
    await mkdir(folder)
    await expect(deps().readRequest(folder)).rejects.toThrow(/regular file/)
    const big = join(dir, 'b.request.json')
    await writeFile(big, 'x'.repeat(70 * 1024))
    await expect(deps().readRequest(big)).rejects.toThrow(/too large/)
  })
})

describe('writing as root into a folder the user owns', () => {
  it('replaces a symlink planted at the result path instead of writing through it', async () => {
    const target = join(dir, 'passwd')
    await writeFile(target, 'untouched')
    const path = join(dir, 's.result.json')
    await symlink(target, path)
    await deps().writeResult(path, '{"outcome":"completed"}\n')
    expect(await readFile(target, 'utf8')).toBe('untouched')
    expect(await readFile(path, 'utf8')).toBe('{"outcome":"completed"}\n')
    expect((await stat(path)).mode & 0o777).toBe(0o644)
  })

  it('writes a system file atomically with exactly the given mode, creating its folder', async () => {
    const path = join(dir, 'etc/apt/keyrings/docker.asc')
    await deps().writeFile(path, Buffer.from('key'), 0o644)
    expect(await readFile(path, 'utf8')).toBe('key')
    expect((await stat(path)).mode & 0o777).toBe(0o644)
    expect((await stat(join(dir, 'etc/apt/keyrings'))).mode & 0o777).toBe(0o755)
  })

  it('a write that cannot land leaves no temporary file behind and reports the error', async () => {
    const blocked = join(dir, 'blocked')
    await mkdir(join(blocked, 's.result.json'), { recursive: true }) // a directory where the file goes
    await expect(deps().writeResult(join(blocked, 's.result.json'), 'x')).rejects.toThrow()
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(blocked)).toEqual(['s.result.json'])
  })

  it('reads an unreadable path as an error, not as absent', async () => {
    await expect(deps().readFile(dir)).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('reads an absent file as null', async () => {
    expect(await deps().readFile(join(dir, 'nothing'))).toBeNull()
    await writeFile(join(dir, 'f'), 'x')
    expect(Buffer.from((await deps().readFile(join(dir, 'f')))!).toString()).toBe('x')
  })
})

describe('running commands', () => {
  it('runs an argv with the recipe environment, not the caller', async () => {
    const script = 'process.stdout.write(JSON.stringify([process.env.PATH, process.env.APT_CONFIG ?? null]))'
    const previous = process.env['APT_CONFIG']
    process.env['APT_CONFIG'] = '/tmp/evil.conf'
    try {
      const output = await deps().exec([process.execPath, '-e', script])
      expect(output.code).toBe(0)
      expect(JSON.parse(output.stdout)).toEqual([INSTALL_CONTAINER_RUNTIME_RECIPE.environment.PATH, null])
    } finally {
      if (previous === undefined) delete process.env['APT_CONFIG']
      else process.env['APT_CONFIG'] = previous
    }
  })
})

describe('who asked for elevation', () => {
  it.each<[NodeJS.ProcessEnv, string | null]>([
    [{ PKEXEC_UID: '1000' }, '1000'],
    [{ SUDO_UID: '1001' }, '1001'],
    [{ PKEXEC_UID: '1000', SUDO_UID: '1001' }, '1000'],
    [{}, null],
    [{ SUDO_UID: 'alice' }, null],
  ])('%j → %s', (env, uid) => {
    expect(invokingUidFrom(env)).toBe(uid)
    expect(nodeHostStepDeps(env).invokingUid).toBe(uid)
  })
})
