import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invokingUidFrom, nodeHostFs, nodeHostStepDeps } from './executor-io.js'
import type { HostFs } from './executor-io.js'
import { INSTALL_CONTAINER_RUNTIME_RECIPE } from './install-container-runtime.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-host-step-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** The tests run unprivileged: this process's uid stands in for the one that asked for elevation. */
const me = String(process.getuid?.() ?? 1000)
const deps = (fs: HostFs = nodeHostFs) => nodeHostStepDeps({ PKEXEC_UID: me }, fs)

/** The real file system, except that the named paths report another owner. */
const ownedBy = (uid: number, ...paths: string[]): HostFs => ({
  ...nodeHostFs,
  lstat: async (path) => {
    const info = await nodeHostFs.lstat(path)
    return paths.includes(path)
      ? {
          ...info,
          uid,
          isDirectory: () => info.isDirectory(),
          isSymbolicLink: () => info.isSymbolicLink(),
        }
      : info
  },
  open: async (path, flags, mode) => {
    const handle = await nodeHostFs.open(path, flags, mode)
    if (!paths.includes(path)) return handle
    return Object.assign(Object.create(handle) as typeof handle, {
      stat: async () => {
        const info = await handle.stat()
        return { size: info.size, mode: info.mode, uid, isFile: () => info.isFile() }
      },
      close: () => handle.close(),
      readFile: (encoding: 'utf8') => handle.readFile(encoding),
    })
  },
})
const ownedByStranger = (...paths: string[]): HostFs => ownedBy(4242, ...paths)

async function request(name = 's.request.json', body = '{"a":1}', mode = 0o644): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, body)
  await chmod(path, mode)
  return path
}

describe('reading the request as root', () => {
  it('reads a regular file the invoking user owns', async () => {
    expect(await deps().readRequest(await request())).toBe('{"a":1}')
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
    await expect(deps().readRequest(await request('b.request.json', 'x'.repeat(70 * 1024)))).rejects.toThrow(
      /too large/
    )
  })

  it('refuses a FIFO without blocking on it', async () => {
    const path = join(dir, 'f.request.json')
    execFileSync('mkfifo', [path])
    await expect(deps().readRequest(path)).rejects.toThrow(/regular file/)
  })

  it('refuses a request other users could have written', async () => {
    await expect(deps().readRequest(await request('g.request.json', '{}', 0o664))).rejects.toMatchObject({
      code: 'MANAGED_HOST_STEP_INVALID',
      message: expect.stringMatching(/group- or world-writable/),
    })
    await expect(deps().readRequest(await request('w.request.json', '{}', 0o646))).rejects.toThrow(
      /group- or world-writable/
    )
  })

  it('refuses a request owned by someone other than the invoking user or root', async () => {
    const path = await request()
    await expect(deps(ownedByStranger(path)).readRequest(path)).rejects.toThrow(/owned by uid 4242/)
    // Started as root directly: only root's own files are trusted (moot when the suite runs as root).
    if (me !== '0')
      await expect(nodeHostStepDeps({}).readRequest(path)).rejects.toThrow(new RegExp(`owned by uid ${me}`))
  })

  it('refuses a request whose folder is a symlink, writable by others, or someone else’s', async () => {
    const real = join(dir, 'real')
    await mkdir(real, { mode: 0o700 })
    await writeFile(join(real, 's.request.json'), '{}')
    await symlink(real, join(dir, 'link'))
    await expect(deps().readRequest(join(dir, 'link', 's.request.json'))).rejects.toThrow(/not a directory/)

    await chmod(real, 0o775)
    await expect(deps().readRequest(join(real, 's.request.json'))).rejects.toThrow(/group- or world-writable/)
    await chmod(real, 0o700)
    await expect(deps(ownedByStranger(real)).readRequest(join(real, 's.request.json'))).rejects.toThrow(
      /owned by uid 4242/
    )
    expect(await deps().readRequest(join(real, 's.request.json'))).toBe('{}')
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

  it('creates the temporary file exclusively without following links, and sets its mode on the handle', async () => {
    const events: string[] = []
    const recording: HostFs = {
      ...nodeHostFs,
      open: async (path, flags, mode) => {
        events.push(`open ${flags}`)
        const handle = await nodeHostFs.open(path, flags, mode)
        return Object.assign(Object.create(handle) as typeof handle, {
          writeFile: (data: Uint8Array | string) => handle.writeFile(data),
          sync: () => handle.sync(),
          chmod: async (m: number) => {
            events.push(`fchmod ${m.toString(8)}`)
            await handle.chmod(m)
          },
          close: async () => {
            events.push('close')
            await handle.close()
          },
        })
      },
      rename: async (from, to) => {
        events.push('rename')
        await nodeHostFs.rename(from, to)
      },
    }
    await deps(recording).writeResult(join(dir, 's.result.json'), '{}')
    const expected = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
    expect(events).toEqual([`open ${expected}`, 'fchmod 644', 'close', 'rename'])
  })

  it('refuses to write into a folder that is a symlink, writable by others, or someone else’s', async () => {
    const real = join(dir, 'real')
    await mkdir(real, { mode: 0o700 })
    await symlink(real, join(dir, 'link'))
    await expect(deps().writeResult(join(dir, 'link', 's.result.json'), '{}')).rejects.toThrow(
      /not a directory/
    )
    await chmod(real, 0o777)
    await expect(deps().writeResult(join(real, 's.result.json'), '{}')).rejects.toThrow(
      /group- or world-writable/
    )
    await chmod(real, 0o700)
    await expect(deps(ownedByStranger(real)).writeResult(join(real, 's.result.json'), '{}')).rejects.toThrow(
      /owned by uid 4242/
    )
    expect(await readdir(real)).toEqual([])
  })

  it('with an invoking user known, never trusts a root-owned folder for the request or the result', async () => {
    // Otherwise `host-step exec /etc/<dir>/<x>.request.json` would have root write a result into /etc.
    const path = await request()
    await expect(deps(ownedBy(0, dir)).readRequest(path)).rejects.toThrow(/owned by uid 0/)
    await expect(deps(ownedBy(0, dir)).writeResult(join(dir, 's.result.json'), '{}')).rejects.toThrow(
      /owned by uid 0/
    )
    expect(await readdir(dir)).toEqual(['s.request.json'])
  })

  it('writes a system file only into a folder root owns', async () => {
    const path = join(dir, 'keyrings/docker.asc')
    await mkdir(join(dir, 'keyrings'), { mode: 0o755 })
    await expect(deps().writeFile(path, Buffer.from('key'), 0o644)).rejects.toThrow(
      new RegExp(`owned by uid ${me}`)
    )
    expect(await readdir(join(dir, 'keyrings'))).toEqual([])
  })

  it('writes a system file atomically with exactly the given mode, creating its folder', async () => {
    const path = join(dir, 'etc/apt/keyrings/docker.asc')
    await deps(ownedBy(0, join(dir, 'etc/apt/keyrings'))).writeFile(path, Buffer.from('key'), 0o644)
    expect(await readFile(path, 'utf8')).toBe('key')
    expect((await stat(path)).mode & 0o777).toBe(0o644)
    expect((await stat(join(dir, 'etc/apt/keyrings'))).mode & 0o777).toBe(0o755)
  })

  it('a write that cannot land leaves no temporary file behind and reports the error', async () => {
    const blocked = join(dir, 'blocked')
    await mkdir(join(blocked, 's.result.json'), { recursive: true }) // a directory where the file goes
    await expect(deps().writeResult(join(blocked, 's.result.json'), 'x')).rejects.toThrow()
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
      for (const options of [undefined, { longRunning: true }]) {
        const output = await deps().exec([process.execPath, '-e', script], options)
        expect(output.code).toBe(0)
        expect(JSON.parse(output.stdout)).toEqual([INSTALL_CONTAINER_RUNTIME_RECIPE.environment.PATH, null])
      }
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
