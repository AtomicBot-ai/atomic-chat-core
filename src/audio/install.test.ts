/**
 * The probe tests run real shell scripts standing in for `audiocpp_server`, so they are POSIX-only,
 * like sd.cpp's. The parsers read the output of upstream v0.9.3 (`test/fixtures/audiocpp/v0.9.3/`).
 */
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import type { AudioBackendInstallRecord } from '../contracts/index.js'
import { INSTALL_RECORD, OWNER_MARKER } from '../diffusion/index.js'
import {
  audioDevicesVerdict,
  audioServerBinaryName,
  audioVersionVerdict,
  listInstalledAudioBuilds,
  parseAudioDevices,
  parseAudioVersion,
  prepareAudiocppTree,
  readAudioInstallRecord,
  writeAudioInstallRecord,
} from './install.js'

const posix = process.platform !== 'win32'
const SERVER = audioServerBinaryName(process.platform)
const FIXTURES = join(import.meta.dirname, '..', '..', 'test', 'fixtures', 'audiocpp', 'v0.9.3')
const fixture = (name: string) => readFile(join(FIXTURES, name), 'utf8')
const ok = { code: 0, signal: null }

let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'atomic-core-audio-install-')))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function refusal(work: Promise<unknown>): Promise<AtomicCoreError> {
  const error = await work.then(
    () => undefined,
    (e: unknown) => e
  )
  expect(error).toBeInstanceOf(AtomicCoreError)
  return error as AtomicCoreError
}

const record = (
  dir: string,
  overrides: Partial<AudioBackendInstallRecord> = {}
): AudioBackendInstallRecord => ({
  tag: 'v0.9.3-a1b2c3d',
  backendId: 'macos-arm64',
  backend: 'metal',
  engine: 'audio-cpp',
  sha256: 'abc',
  installedAtMs: 1234,
  dir,
  ...overrides,
})

async function script(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
}

describe('audioServerBinaryName', () => {
  it('names the server for the platform', () => {
    expect(audioServerBinaryName('win32')).toBe('audiocpp_server.exe')
    expect(audioServerBinaryName('darwin')).toBe('audiocpp_server')
    expect(audioServerBinaryName('linux')).toBe('audiocpp_server')
  })
})

describe('the install record', () => {
  it('round-trips, camelCase on disk, with the ownership marker beside it', async () => {
    await writeAudioInstallRecord(root, record(root))
    expect(JSON.parse(await readFile(join(root, INSTALL_RECORD), 'utf8'))).toEqual({
      tag: 'v0.9.3-a1b2c3d',
      backendId: 'macos-arm64',
      backend: 'metal',
      engine: 'audio-cpp',
      sha256: 'abc',
      installedAtMs: 1234,
    })
    expect(await readFile(join(root, OWNER_MARKER), 'utf8')).toBe('atomic-chat\n')
    expect(await readAudioInstallRecord(root)).toEqual(record(root))
  })

  it('reads a missing sha256 as null and refuses a record of another engine or backend', async () => {
    const write = (body: unknown) => writeFile(join(root, INSTALL_RECORD), JSON.stringify(body))
    const { dir: _dir, ...file } = record(root)
    await write({ ...file, sha256: undefined })
    expect((await readAudioInstallRecord(root))?.sha256).toBeNull()
    await write({ ...file, engine: 'sd-cpp' })
    expect(await readAudioInstallRecord(root)).toBeUndefined()
    await write({ ...file, backend: 'rocm' })
    expect(await readAudioInstallRecord(root)).toBeUndefined()
    await write({ ...file, installedAtMs: -1 })
    expect(await readAudioInstallRecord(root)).toBeUndefined()
    await write([])
    expect(await readAudioInstallRecord(root)).toBeUndefined()
    await writeFile(join(root, INSTALL_RECORD), '{')
    expect(await readAudioInstallRecord(root)).toBeUndefined()
  })
})

describe('listInstalledAudioBuilds', () => {
  async function build(tag: string, backendId: string, installedAtMs: number, withServer = true) {
    const dir = join(root, tag, backendId)
    await mkdir(dir, { recursive: true })
    await writeAudioInstallRecord(dir, record(dir, { tag, backendId, installedAtMs }))
    if (withServer) await writeFile(join(dir, SERVER), '')
    return dir
  }

  it('lists owned builds with their server, newest install first', async () => {
    await build('v0.9.2', 'macos-arm64', 10)
    await build('v0.9.3', 'macos-arm64', 30)
    await build('v0.9.3-a1b2c3d', 'macos-arm64', 20, false)
    await mkdir(join(root, 'v0.9.1', 'stray'), { recursive: true })
    await writeFile(join(root, 'not-a-dir'), '')
    const builds = await listInstalledAudioBuilds(root)
    expect(builds.map((b) => b.tag)).toEqual(['v0.9.3', 'v0.9.2'])
  })

  it('answers nothing for a missing root', async () => {
    expect(await listInstalledAudioBuilds(join(root, 'missing'))).toEqual([])
  })
})

describe('parseAudioVersion', () => {
  it("reads upstream v0.9.3's --version", async () => {
    expect(parseAudioVersion(await fixture('version-macos-arm64.txt'))).toEqual({
      version: '0.9.3',
      backends: ['cpu', 'metal'],
    })
  })

  it('answers null for anything else, and no backends when the line is missing', async () => {
    expect(parseAudioVersion(await fixture('help.txt'))).toBeNull()
    expect(parseAudioVersion('llama-server version 1\n')).toBeNull()
    expect(parseAudioVersion('audio.cpp dev\n')).toEqual({ version: 'dev', backends: [] })
  })
})

describe('parseAudioDevices', () => {
  it("reads upstream v0.9.3's --list-devices through the Metal noise", async () => {
    expect(parseAudioDevices(await fixture('list-devices-macos-arm64.txt'))).toEqual([
      { registry: 'MTL', index: 0, name: 'Apple M4 Pro', type: 'GPU' },
      { registry: 'BLAS', index: 0, name: 'Accelerate', type: 'ACCEL' },
      { registry: 'CPU', index: 0, name: 'Apple M4 Pro', type: 'CPU' },
    ])
  })
})

describe('audioVersionVerdict', () => {
  it('passes audio.cpp carrying the backend, and a build that names no backends', async () => {
    const text = await fixture('version-macos-arm64.txt')
    expect(audioVersionVerdict('s', text, ok, 'darwin', 'metal')).toBeUndefined()
    expect(audioVersionVerdict('s', text, ok, 'darwin', 'cpu')).toBeUndefined()
    expect(audioVersionVerdict('s', 'audio.cpp 1.0.0\n', ok, 'linux', 'vulkan')).toBeUndefined()
  })

  it('refuses a build without the backend, another program, silence and a missing library', async () => {
    const text = await fixture('version-macos-arm64.txt')
    expect(audioVersionVerdict('s', text, ok, 'darwin', 'cuda')?.message).toBe(
      'The audio engine build does not carry the cuda backend.'
    )
    expect(audioVersionVerdict('s', 'usage: llama-server', ok, 'linux', 'cpu')?.message).toBe(
      'The downloaded binary is not audio.cpp.'
    )
    expect(audioVersionVerdict('s', '  ', { code: 1, signal: null }, 'linux', 'cpu')).toMatchObject({
      code: 'ENGINE_INSTALL_FAILED',
      message: 'The audio engine exited without printing anything.',
      details: 's: exit code 1',
    })
    expect(audioVersionVerdict('s', '', { code: null, signal: 'SIGKILL' }, 'linux', 'cpu')?.details).toBe(
      's: signal SIGKILL'
    )
    expect(
      audioVersionVerdict(
        's',
        'error while loading shared libraries: libvulkan.so.1',
        { code: 127, signal: null },
        'linux',
        'vulkan'
      )?.message
    ).toBe('The audio engine could not load a library it needs.')
    expect(audioVersionVerdict('s', '', { code: 0xc000_0135, signal: null }, 'win32', 'cuda')?.message).toBe(
      'The audio engine could not load a library it needs.'
    )
  })
})

describe('audioDevicesVerdict', () => {
  it('passes a GPU build that sees a GPU, and every CPU build', async () => {
    const text = await fixture('list-devices-macos-arm64.txt')
    expect(audioDevicesVerdict('s', text, ok, 'darwin', 'metal')).toBeUndefined()
    expect(audioDevicesVerdict('s', 'CPU:0 "x" [CPU]\n', ok, 'linux', 'cpu')).toBeUndefined()
    expect(audioDevicesVerdict('s', 'Vulkan:0 "Intel Iris" [IGPU]\n', ok, 'win32', 'vulkan')).toBeUndefined()
  })

  it('refuses a GPU build that sees no GPU, or whose library is missing', () => {
    expect(
      audioDevicesVerdict('s', 'available_devices=1\nCPU:0 "x" [CPU]\n', ok, 'linux', 'vulkan')
    ).toMatchObject({
      code: 'ENGINE_INSTALL_FAILED',
      message: 'The audio engine found no vulkan device on this computer.',
    })
    expect(audioDevicesVerdict('s', '', { code: 0xc000_0135, signal: null }, 'win32', 'cuda')?.message).toBe(
      'The audio engine could not load a library it needs.'
    )
  })
})

describe('prepareAudiocppTree', () => {
  it('refuses a tree without the server', async () => {
    const error = await refusal(prepareAudiocppTree(root, 'cpu'))
    expect(error.message).toBe('The archive did not contain audiocpp_server.')
  })

  it.skipIf(!posix)('passes a CPU build on --version alone', async () => {
    await script(
      join(root, SERVER),
      'if [ "$1" = "--version" ]; then printf "audio.cpp 0.9.3\\nbackends: cpu\\n"; else exit 3; fi'
    )
    const log: string[] = []
    await prepareAudiocppTree(root, 'cpu', { log: (_level, msg) => log.push(msg) })
    expect(log.some((line) => line.startsWith('audio engine probe passed'))).toBe(true)
  })

  it.skipIf(!posix)('lists the devices of a GPU build and refuses one that sees no GPU', async () => {
    const body = (devices: string) =>
      [
        'case "$1" in',
        '  --version) printf "audio.cpp 0.9.3\\nbackends: cpu,vulkan\\n" ;;',
        `  --list-devices) printf "available_devices=1\\n${devices}\\n" ;;`,
        'esac',
      ].join('\n')
    await script(join(root, SERVER), body('Vulkan0:0 \\"Radeon\\" [GPU]'))
    await prepareAudiocppTree(root, 'vulkan')
    await script(join(root, SERVER), body('CPU:0 \\"x\\" [CPU]'))
    const log: string[] = []
    const error = await refusal(prepareAudiocppTree(root, 'vulkan', { log: (_l, m) => log.push(m) }))
    expect(error.message).toBe('The audio engine found no vulkan device on this computer.')
    expect(log.some((line) => line.startsWith('audio engine probe failed'))).toBe(true)
  })

  it.skipIf(!posix)('refuses a binary that is not audio.cpp', async () => {
    await script(join(root, SERVER), 'echo "usage: sd-server"')
    expect((await refusal(prepareAudiocppTree(root, 'cpu'))).message).toBe(
      'The downloaded binary is not audio.cpp.'
    )
  })
})
