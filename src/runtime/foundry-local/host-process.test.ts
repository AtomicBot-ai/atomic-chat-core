import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { foundryHostCommand, runFoundryHostProbe } from './host-process.js'

const POSIX = process.platform !== 'win32'
let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-foundry-host-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

/** A stand-in for `atomic-chat-core foundry-host`: prints its argv to a file, then runs `body`. */
async function fakeHost(body: string): Promise<string> {
  const file = join(dir, 'fake-host')
  await writeFile(file, `#!/bin/sh\necho "$@" > "${join(dir, 'argv')}"\n${body}\n`)
  await chmod(file, 0o755)
  return file
}

describe.skipIf(!POSIX)('runFoundryHostProbe', () => {
  it('runs `probe --lib --app-data` and reads the JSON line it prints', async () => {
    const exe = await fakeHost(
      `echo "loading"; echo '{"c_api_version":2,"accelerators":[{"name":"WebGpuExecutionProvider","device":"gpu","prepared":true}]}'`
    )
    const result = await runFoundryHostProbe(
      { exe, args: [] },
      { libDir: '/builds/v2.1.0/macos-arm64', appDataDir: '/data/rt' }
    )
    expect(result).toEqual({
      c_api_version: 2,
      accelerators: [{ name: 'WebGpuExecutionProvider', device: 'gpu', prepared: true }],
    })
    const { readFile } = await import('node:fs/promises')
    expect((await readFile(join(dir, 'argv'), 'utf8')).trim()).toBe(
      'probe --lib /builds/v2.1.0/macos-arm64 --app-data /data/rt'
    )
  })

  it('fails with what the host printed when the library does not load', async () => {
    const exe = await fakeHost(
      `echo 'Failed to open library: libatomic.so.1: cannot open shared object file' >&2; exit 3`
    )
    await expect(
      runFoundryHostProbe({ exe, args: [] }, { libDir: '/l', appDataDir: '/a' })
    ).rejects.toMatchObject({
      code: 'ENGINE_INSTALL_FAILED',
      details: expect.stringContaining('libatomic.so.1'),
    })
  })

  it('fails when the host prints no probe answer', async () => {
    const exe = await fakeHost(`echo 'not json'`)
    await expect(
      runFoundryHostProbe({ exe, args: [] }, { libDir: '/l', appDataDir: '/a' })
    ).rejects.toMatchObject({
      code: 'ENGINE_INSTALL_FAILED',
    })
  })

  it('stops a host that does not answer in time', async () => {
    const exe = await fakeHost('sleep 5')
    await expect(
      runFoundryHostProbe({ exe, args: [] }, { libDir: '/l', appDataDir: '/a' }, { timeoutMs: 200 })
    ).rejects.toMatchObject({
      code: 'ENGINE_INSTALL_FAILED',
      message: expect.stringMatching(/did not answer/),
    })
  })
})

describe('foundryHostCommand', () => {
  it('is this binary in foundry-host mode, the entry script included under a runtime', () => {
    expect(foundryHostCommand({}, ['/bin/atomic-chat-core', 'daemon'], '/bin/atomic-chat-core')).toEqual({
      exe: '/bin/atomic-chat-core',
      args: ['foundry-host'],
    })
    expect(
      foundryHostCommand({}, ['/usr/bin/node', '/pkg/dist/cli/bin.js', 'daemon'], '/usr/bin/node')
    ).toEqual({
      exe: '/usr/bin/node',
      args: ['/pkg/dist/cli/bin.js', 'foundry-host'],
    })
  })

  it('is the e2e stand-in when the test hook names one', () => {
    expect(foundryHostCommand({ ATOMIC_FOUNDRY_HOST_TEST_COMMAND: '/tmp/fake-host' }, [], '/bin/x')).toEqual({
      exe: '/tmp/fake-host',
      args: [],
    })
  })
})
