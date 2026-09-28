import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostExec } from './host-exec.js'
import {
  currentUserName,
  managedTestHostDir,
  MANAGED_TEST_HOST_ENV,
  realLinuxHost,
  testLinuxHost,
} from './linux-host.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'linux-host-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const answer = vi.fn<HostExec>(async () => ({ code: 0, stdout: 'ok', stderr: '' }))

describe('realLinuxHost', () => {
  it('runs docker by its absolute system path, never whatever PATH finds first', async () => {
    const exec = vi.fn<HostExec>(async () => ({ code: 0, stdout: '', stderr: '' }))
    const host = realLinuxHost({}, exec, async () => '/usr/bin/docker')
    await host.probeDeps.exec('docker', ['--version'])
    await host.probeDeps.exec('nvidia-smi', ['-L'])
    expect(exec).toHaveBeenNthCalledWith(1, '/usr/bin/docker', ['--version'], undefined)
    expect(exec).toHaveBeenNthCalledWith(2, 'nvidia-smi', ['-L'], undefined)
  })

  it('answers "no docker CLI" without spawning anything when none is installed', async () => {
    const exec = vi.fn<HostExec>()
    const host = realLinuxHost({}, exec, async () => null)
    expect((await host.probeDeps.exec('docker', ['info'])).code).toBeNull()
    expect(exec).not.toHaveBeenCalled()
  })

  it('reads a missing file as null, but refuses to read an unreadable one as missing', async () => {
    const host = realLinuxHost({}, answer)
    expect(await host.probeDeps.readFile(join(dir, 'nope'))).toBeNull()
    await writeFile(join(dir, 'here'), 'text')
    expect(await host.probeDeps.readFile(join(dir, 'here'))).toBe('text')
    // A directory where a file is expected is EISDIR, not "not configured".
    await expect(host.probeDeps.readFile(dir)).rejects.toThrow()
  })

  it('checks existence and free space on the real filesystem', async () => {
    const host = realLinuxHost({ XDG_RUNTIME_DIR: '/run/user/1000' }, answer)
    expect(await host.probeDeps.pathExists(dir)).toBe(true)
    expect(await host.probeDeps.pathExists(join(dir, 'nope'))).toBe(false)
    expect(await host.probeDeps.freeDiskBytes(dir)).toBeGreaterThan(0)
    expect(host.options().xdgRuntimeDir).toBe('/run/user/1000')
    expect(host.dockerPath).toBeUndefined()
  })
})

describe('testLinuxHost (the e2e hook)', () => {
  it('is off unless the variable names a folder', () => {
    expect(managedTestHostDir({})).toBeNull()
    expect(managedTestHostDir({ [MANAGED_TEST_HOST_ENV]: '  ' })).toBeNull()
    expect(managedTestHostDir({ [MANAGED_TEST_HOST_ENV]: dir })).toBe(dir)
  })

  it('maps commands, files, free space and the docker socket into its folder', async () => {
    const exec = vi.fn<HostExec>(async () => ({ code: 0, stdout: '', stderr: '' }))
    const host = testLinuxHost(dir, {}, exec)
    await host.probeDeps.exec('uname', ['-m'])
    expect(exec).toHaveBeenCalledWith(join(dir, 'bin', 'uname'), ['-m'], undefined)

    await mkdir(join(dir, 'root', 'etc'), { recursive: true })
    await writeFile(join(dir, 'root', 'etc', 'os-release'), 'ID=ubuntu\n')
    expect(await host.probeDeps.readFile('/etc/os-release')).toBe('ID=ubuntu\n')
    expect(await host.probeDeps.pathExists('/etc')).toBe(true)
    expect(await host.probeDeps.pathExists('/run/ostree-booted')).toBe(false)

    expect(await host.probeDeps.freeDiskBytes('/')).toBeGreaterThan(0)
    await writeFile(join(dir, 'free-disk-bytes'), '123456\n')
    expect(await host.probeDeps.freeDiskBytes('/')).toBe(123456)

    expect(host.dockerPath).toBe(join(dir, 'bin', 'docker'))
    expect(host.dockerSocketPath).toBe(join(dir, 'docker.sock'))
  })
})

describe('currentUserName', () => {
  it('is root for uid 0 whatever the account is called, the login name otherwise', () => {
    expect(currentUserName(() => ({ uid: 0, username: 'toor' }))).toBe('root')
    expect(currentUserName(() => ({ uid: 1000, username: 'ada' }))).toBe('ada')
    expect(currentUserName()).toBeTruthy()
  })
})
