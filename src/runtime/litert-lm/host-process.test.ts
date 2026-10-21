import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LITERT_HOST_TEST_COMMAND_ENV, liteRtHostCommand, runLiteRtHostProbe } from './host-process.js'

const POSIX = process.platform !== 'win32'
let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-litert-host-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

/** A stand-in for `atomic-chat-core litert-host`: prints its argv to a file, then runs `body`. */
async function fakeHost(body: string): Promise<string> {
  const file = join(dir, 'fake-host')
  await writeFile(file, `#!/bin/sh\necho "$@" > "${join(dir, 'argv')}"\n${body}\n`)
  await chmod(file, 0o755)
  return file
}

describe('liteRtHostCommand', () => {
  it('runs this binary in litert-host mode, through the script under a runtime, or the test stand-in', () => {
    expect(liteRtHostCommand({}, ['/bin/core', 'serve'], '/bin/core')).toEqual({
      exe: '/bin/core',
      args: ['litert-host'],
    })
    expect(liteRtHostCommand({}, ['/usr/bin/node', '/src/cli/bin.ts'], '/usr/bin/node')).toEqual({
      exe: '/usr/bin/node',
      args: ['/src/cli/bin.ts', 'litert-host'],
    })
    expect(liteRtHostCommand({ [LITERT_HOST_TEST_COMMAND_ENV]: '/fake' }, [], '/bin/core')).toEqual({
      exe: '/fake',
      args: [],
    })
    expect(LITERT_HOST_TEST_COMMAND_ENV).toBe('ATOMIC_LITERT_HOST_TEST_COMMAND')
  })
})

describe.skipIf(!POSIX)('runLiteRtHostProbe', () => {
  it('runs `probe --lib <build>` and reads the JSON line it prints', async () => {
    const exe = await fakeHost(`echo "loading"; echo '{"version":"0.18.1","abi":1,"backends":["cpu","gpu"]}'`)
    expect(await runLiteRtHostProbe({ exe, args: [] }, '/builds/0.18.1/linux-x64')).toEqual({
      version: '0.18.1',
      abi: 1,
      backends: ['cpu', 'gpu'],
    })
    expect((await readFile(join(dir, 'argv'), 'utf8')).trim()).toBe('probe --lib /builds/0.18.1/linux-x64')
  })

  it('fails with what the host printed when the library does not load', async () => {
    const exe = await fakeHost(`echo 'dlopen: liblitert-lm.so: cannot open shared object file' >&2; exit 3`)
    await expect(runLiteRtHostProbe({ exe, args: [] }, '/l')).rejects.toMatchObject({
      code: 'ENGINE_INSTALL_FAILED',
      details: expect.stringContaining('liblitert-lm.so'),
    })
  })

  it('fails when the host prints no probe answer or does not answer in time', async () => {
    await expect(
      runLiteRtHostProbe({ exe: await fakeHost(`echo 'not json'`), args: [] }, '/l')
    ).rejects.toMatchObject({
      code: 'ENGINE_INSTALL_FAILED',
    })
    await expect(
      runLiteRtHostProbe({ exe: await fakeHost('sleep 5'), args: [] }, '/l', { timeoutMs: 100 })
    ).rejects.toMatchObject({ code: 'ENGINE_INSTALL_FAILED', details: expect.stringMatching(/timed out/) })
  })
})
