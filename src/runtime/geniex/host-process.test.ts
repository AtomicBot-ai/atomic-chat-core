import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  GENIEX_HOST_TEST_COMMAND_ENV,
  geniexHostCommand,
  geniexHostProber,
  runGeniexHostInspect,
  runGeniexHostProbe,
} from './host-process.js'

const POSIX = process.platform !== 'win32'
let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-geniex-host-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

/** A stand-in for `atomic-chat-core geniex-host`: prints its argv to a file, then runs `body`. */
async function fakeHost(body: string): Promise<string> {
  const file = join(dir, 'fake-host')
  await writeFile(file, `#!/bin/sh\necho "$@" > "${join(dir, 'argv')}"\n${body}\n`)
  await chmod(file, 0o755)
  return file
}

const PROBE =
  '{"version":"0.9.3","abi":1,"plugins":["llama_cpp","qairt"],"devices":["HTP0","GPUOpenCL","CPU"]}'

describe('geniexHostCommand', () => {
  it('runs this binary in geniex-host mode, through the script under a runtime, or the test stand-in', () => {
    expect(geniexHostCommand({}, ['/bin/core', 'serve'], '/bin/core')).toEqual({
      exe: '/bin/core',
      args: ['geniex-host'],
    })
    expect(geniexHostCommand({}, ['/usr/bin/node', '/src/cli/bin.ts'], '/usr/bin/node')).toEqual({
      exe: '/usr/bin/node',
      args: ['/src/cli/bin.ts', 'geniex-host'],
    })
    expect(geniexHostCommand({ [GENIEX_HOST_TEST_COMMAND_ENV]: '/fake' }, [], '/bin/core')).toEqual({
      exe: '/fake',
      args: [],
    })
    expect(GENIEX_HOST_TEST_COMMAND_ENV).toBe('ATOMIC_GENIEX_HOST_TEST_COMMAND')
  })
})

describe.skipIf(!POSIX)('runGeniexHostProbe', () => {
  it('runs `probe --lib <build>` and reads the JSON line it prints', async () => {
    const exe = await fakeHost(`echo "loading"; echo '${PROBE}'`)
    expect(await runGeniexHostProbe({ exe, args: [] }, '/builds/0.9.3/win-arm64')).toEqual({
      version: '0.9.3',
      abi: 1,
      plugins: ['llama_cpp', 'qairt'],
      devices: ['HTP0', 'GPUOpenCL', 'CPU'],
    })
    expect((await readFile(join(dir, 'argv'), 'utf8')).trim()).toBe('probe --lib /builds/0.9.3/win-arm64')
  })

  it('fails with what the host printed when the library does not load, prints no answer, or hangs', async () => {
    const exe = await fakeHost(`echo 'LoadLibraryW geniex.dll: error 126' >&2; exit 3`)
    await expect(runGeniexHostProbe({ exe, args: [] }, '/l')).rejects.toMatchObject({
      code: 'ENGINE_INSTALL_FAILED',
      details: expect.stringContaining('error 126'),
    })
    await expect(
      runGeniexHostProbe({ exe: await fakeHost(`echo 'not json'`), args: [] }, '/l')
    ).rejects.toMatchObject({
      code: 'ENGINE_INSTALL_FAILED',
    })
    await expect(
      runGeniexHostProbe({ exe: await fakeHost('sleep 5'), args: [] }, '/l', { timeoutMs: 100 })
    ).rejects.toMatchObject({ code: 'ENGINE_INSTALL_FAILED', details: expect.stringMatching(/timed out/) })
  })
})

describe.skipIf(!POSIX)('runGeniexHostInspect', () => {
  it('runs `inspect <path>` and reads the metadata', async () => {
    const info = {
      kind: 'gguf',
      architecture: 'qwen3',
      max_context_tokens: 40960,
      quantization: 'Q4_0',
      chat_template: true,
      vision: false,
    }
    const exe = await fakeHost(`echo '${JSON.stringify(info)}'`)
    expect(await runGeniexHostInspect({ exe, args: [] }, '/m/qwen3.gguf')).toMatchObject(info)
    expect((await readFile(join(dir, 'argv'), 'utf8')).trim()).toBe('inspect /m/qwen3.gguf')
  })

  it('fails with GENIEX_HOST_ERROR and the host message for a file it cannot read', async () => {
    const exe = await fakeHost(`echo 'not a GGUF file: bad magic' >&2; exit 4`)
    await expect(runGeniexHostInspect({ exe, args: [] }, '/m/cut.gguf')).rejects.toMatchObject({
      code: 'GENIEX_HOST_ERROR',
      details: expect.stringContaining('bad magic'),
    })
  })
})

describe.skipIf(!POSIX)('geniexHostProber', () => {
  it('is the engine-builds probe: resolves with the devices and version, rejects with what the host printed', async () => {
    const ok = geniexHostProber({ exe: await fakeHost(`echo '${PROBE}'`), args: [] }, process.env)
    await expect(ok('/b')).resolves.toEqual({
      libraryVersion: '0.9.3',
      devices: ['HTP0', 'GPUOpenCL', 'CPU'],
    })
    const broken = geniexHostProber(
      { exe: await fakeHost(`echo 'error 126' >&2; exit 3`), args: [] },
      process.env
    )
    await expect(broken('/b')).rejects.toMatchObject({
      code: 'ENGINE_INSTALL_FAILED',
      details: expect.stringContaining('126'),
    })
  })
})
