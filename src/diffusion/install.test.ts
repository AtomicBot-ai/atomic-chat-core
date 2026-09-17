/**
 * Hand-ported from the `#[test]` table of `install.rs` in `tauri-plugin-atomic-diffusion` (app commit
 * `767ff6350`). The probe tests run real shell scripts, so they are POSIX-only, as they were in Rust.
 */
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import type { DiffusionBackendInstallRecord, FinalizeBackendInstallArgs } from '../contracts/index.js'
import {
  cliBinaryName,
  deleteModelFile,
  ensureDirs,
  finalizeBackendInstall,
  INSTALL_RECORD,
  isOwned,
  listInstalledBackends,
  listModelFiles,
  OWNER_MARKER,
  probeBinary,
  probeOutputIsSdcpp,
  readInstallRecord,
  removeBackend,
  serverBinaryName,
  writeInstallRecord,
} from './install.js'

const posix = process.platform !== 'win32'
const SERVER = serverBinaryName(process.platform)
const CLI = cliBinaryName(process.platform)

let root: string
let outside: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'atomic-core-install-')))
  outside = await realpath(await mkdtemp(join(tmpdir(), 'atomic-core-install-outside-')))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false
  )

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
  overrides: Partial<DiffusionBackendInstallRecord> = {}
): DiffusionBackendInstallRecord => ({
  tag: 'master-849-d04e895',
  backendId: 'macos-arm64',
  backend: 'metal',
  engine: 'sd-cpp',
  sha256: 'abc',
  installedAtMs: 1234,
  dir,
  ...overrides,
})

async function script(path: string, body: string, mode = 0o755): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, mode)
}

describe('the install record', () => {
  it('round-trips, camelCase on disk, with the ownership marker beside it', async () => {
    await writeInstallRecord(root, record(root))
    expect(await isOwned(root)).toBe(true)
    expect(await readFile(join(root, OWNER_MARKER), 'utf8')).toBe('atomic-chat\n')
    expect(await readInstallRecord(root)).toEqual(record(root))
    const text = await readFile(join(root, INSTALL_RECORD), 'utf8')
    expect(JSON.parse(text)).toEqual({
      tag: 'master-849-d04e895',
      backendId: 'macos-arm64',
      backend: 'metal',
      engine: 'sd-cpp',
      sha256: 'abc',
      installedAtMs: 1234,
    })
    expect(text).toContain('\n  "backendId"')
  })

  it('reads a record without a checksum, and nothing that is not a record', async () => {
    const write = (value: unknown) => writeFile(join(root, INSTALL_RECORD), JSON.stringify(value))
    const base = { tag: 't', backendId: 'cpu', backend: 'cpu', engine: 'sd-cpp', installedAtMs: 1 }
    await write(base)
    expect(await readInstallRecord(root)).toEqual({ ...base, sha256: null, dir: root })
    for (const broken of [
      [],
      null,
      { ...base, tag: 1 },
      { ...base, backendId: undefined },
      { ...base, backend: 'opencl' },
      { ...base, engine: 'comfy' },
      { ...base, sha256: 5 },
      { ...base, installedAtMs: -1 },
      { ...base, installedAtMs: '1' },
    ]) {
      await write(broken)
      expect(await readInstallRecord(root), JSON.stringify(broken)).toBeUndefined()
    }
    await writeFile(join(root, INSTALL_RECORD), 'not json')
    expect(await readInstallRecord(root)).toBeUndefined()
    expect(await readInstallRecord(join(root, 'missing'))).toBeUndefined()
  })

  it('reports what it could not write', async () => {
    const error = await refusal(writeInstallRecord(join(root, 'missing'), record(root)))
    expect(error.message).toBe('Could not write the ownership marker.')
    await mkdir(join(root, 'tree', INSTALL_RECORD), { recursive: true })
    const second = await refusal(writeInstallRecord(join(root, 'tree'), record(root)))
    expect(second.message).toBe('Could not write the install record.')
  })
})

describe('listInstalledBackends', () => {
  it('walks tag and backend directories and skips trees it does not own', async () => {
    const owned = join(root, 'tag-a', 'macos-arm64')
    await mkdir(owned, { recursive: true })
    await writeFile(join(owned, SERVER), 'bin')
    await writeInstallRecord(owned, record(owned))

    // A record without the marker is somebody else's tree.
    const foreign = join(root, 'tag-a', 'foreign')
    await mkdir(foreign, { recursive: true })
    await writeFile(join(foreign, SERVER), 'bin')
    await writeFile(
      join(foreign, INSTALL_RECORD),
      JSON.stringify({ tag: 't', backendId: 'foreign', backend: 'cpu', engine: 'sd-cpp', installedAtMs: 1 })
    )

    const newer = join(root, 'tag-b', 'win-cuda12-x64')
    await mkdir(newer, { recursive: true })
    await writeFile(join(newer, SERVER), 'bin')
    await writeInstallRecord(newer, record(newer, { installedAtMs: 9999, backendId: 'win-cuda12-x64' }))

    // Owned and recorded, but the server binary is gone: not an install any more.
    const hollow = join(root, 'tag-b', 'hollow')
    await mkdir(hollow, { recursive: true })
    await writeInstallRecord(hollow, record(hollow, { backendId: 'hollow' }))
    await writeFile(join(root, 'stray-file'), 'x')

    const listed = await listInstalledBackends(root)
    expect(listed.map((r) => r.backendId)).toEqual(['win-cuda12-x64', 'macos-arm64'])
    expect(listed[0]?.dir).toBe(newer)
    expect(await listInstalledBackends(join(root, 'missing'))).toEqual([])
  })
})

describe('removeBackend', () => {
  it('refuses trees it does not own, trees outside the root, and the root itself', async () => {
    const unowned = join(root, 'tag', 'cpu')
    await mkdir(unowned, { recursive: true })
    const notOurs = await refusal(removeBackend(root, unowned))
    expect(notOurs.toJSON()).toEqual({
      code: 'INVALID_REQUEST',
      message: 'Refusing to delete a directory Atomic Chat did not install.',
      details: `${unowned} has no .atomic-owned marker`,
    })
    expect(await exists(unowned)).toBe(true)

    await writeFile(join(outside, OWNER_MARKER), 'x')
    const elsewhere = await refusal(removeBackend(root, outside))
    expect(elsewhere.toJSON()).toEqual({
      code: 'INVALID_REQUEST',
      message: 'That directory is not a diffusion backend install.',
      details: outside,
    })
    expect(await exists(outside)).toBe(true)

    expect((await refusal(removeBackend(root, root))).code).toBe('INVALID_REQUEST')
    expect(await exists(root)).toBe(true)
  })

  it('deletes an owned tree and its empty tag directory, and is quiet about one already gone', async () => {
    const owned = join(root, 'tag', 'cpu')
    await mkdir(join(owned, 'lib'), { recursive: true })
    await writeFile(join(owned, 'lib', 'x.so'), 'x')
    await writeInstallRecord(owned, record(owned))
    await removeBackend(root, owned)
    expect(await exists(owned)).toBe(false)
    expect(await exists(join(root, 'tag'))).toBe(false)
    expect(await exists(root)).toBe(true)
    await expect(removeBackend(root, owned)).resolves.toBeUndefined()
  })

  it('keeps a tag directory that still holds another backend', async () => {
    for (const id of ['cpu', 'vulkan']) {
      const dir = join(root, 'tag', id)
      await mkdir(dir, { recursive: true })
      await writeInstallRecord(dir, record(dir, { backendId: id }))
    }
    await removeBackend(root, join(root, 'tag', 'cpu'))
    expect(await exists(join(root, 'tag', 'vulkan'))).toBe(true)
  })
})

describe('model files', () => {
  it('are listed relative to the root and deleted only inside it', async () => {
    const family = join(root, 'z-image')
    await mkdir(family, { recursive: true })
    await writeFile(join(family, 'z.gguf'), '12345')
    await writeFile(join(family, 'z.gguf.tmp'), '1')
    await writeFile(join(family, 'half.part'), '1')
    await writeFile(join(family, 'half.download'), '1')
    await writeFile(join(family, '.hidden'), '1')
    const shared = join(root, 'shared', 'Qwen3-4B')
    await mkdir(shared, { recursive: true })
    await writeFile(join(shared, 'te.gguf'), '12')

    const files = await listModelFiles(root)
    expect(files.map((f) => f.relativePath)).toEqual(['shared/Qwen3-4B/te.gguf', 'z-image/z.gguf'])
    expect(files[1]).toEqual({ path: join(family, 'z.gguf'), relativePath: 'z-image/z.gguf', bytes: 5 })
    expect(await listModelFiles(join(root, 'missing'))).toEqual([])

    const victim = join(outside, 'keep.gguf')
    await writeFile(victim, 'x')
    const refused = await refusal(deleteModelFile(root, victim))
    expect(refused.toJSON()).toEqual({
      code: 'INVALID_REQUEST',
      message: 'That file is not in the diffusion models folder.',
      details: victim,
    })
    expect(await exists(victim)).toBe(true)

    const traversal = join(family, '..', '..', outside.split('/').pop() as string, 'keep.gguf')
    await deleteModelFile(root, traversal).catch(() => {})
    expect(await exists(victim), 'traversal must not escape the models root').toBe(true)
    expect((await refusal(deleteModelFile(root, root))).code).toBe('INVALID_REQUEST')

    const directory = await refusal(deleteModelFile(root, family))
    expect(directory.message).toBe('That path is a directory, not a model file.')

    await deleteModelFile(root, join(family, 'z.gguf'))
    expect(await exists(join(family, 'z.gguf'))).toBe(false)
    expect(await exists(family), 'the folder still has the partial and hidden files').toBe(true)
    await deleteModelFile(root, join(shared, 'te.gguf'))
    expect(await exists(join(root, 'shared')), 'empty family folders are pruned').toBe(false)
    expect(await exists(root)).toBe(true)
    await expect(deleteModelFile(root, join(shared, 'te.gguf'))).resolves.toBeUndefined()
  })

  it.skipIf(!posix)('does not list a link to a file, and refuses to delete through one', async () => {
    const target = join(outside, 'real.gguf')
    await writeFile(target, 'x')
    await mkdir(join(root, 'family'), { recursive: true })
    await symlink(target, join(root, 'family', 'link.gguf'))
    expect(await listModelFiles(root)).toEqual([])
    expect((await refusal(deleteModelFile(root, join(root, 'family', 'link.gguf')))).code).toBe(
      'INVALID_REQUEST'
    )
    expect(await exists(target)).toBe(true)
  })
})

const args = (
  dir: string,
  overrides: Partial<FinalizeBackendInstallArgs> = {}
): FinalizeBackendInstallArgs => ({
  dir,
  tag: 'tag',
  backendId: 'cpu',
  backend: 'cpu',
  engine: 'sd-cpp',
  ...overrides,
})

describe('finalizeBackendInstall', () => {
  it('needs a tree inside the backends root that holds sd-server', async () => {
    const dir = join(root, 'tag', 'cpu')
    const missing = await refusal(finalizeBackendInstall(root, args(dir)))
    expect(missing.toJSON()).toEqual({
      code: 'ENGINE_INSTALL_FAILED',
      message: 'The engine directory does not exist.',
      details: dir,
    })
    await mkdir(dir, { recursive: true })
    const noServer = await refusal(finalizeBackendInstall(root, args(dir)))
    expect(noServer.code).toBe('ENGINE_INSTALL_FAILED')
    expect(noServer.message).toBe('The archive did not contain sd-server.')

    await writeFile(join(outside, SERVER), 'x')
    const elsewhere = await refusal(finalizeBackendInstall(root, args(outside)))
    expect(elsewhere.code).toBe('INVALID_REQUEST')
    expect(elsewhere.message).toBe('The engine directory is outside the diffusion backends folder.')
  })

  it.skipIf(!posix)('makes the binaries executable, probes the CLI and writes the record', async () => {
    const dir = join(root, 'tag', 'cpu')
    await mkdir(dir, { recursive: true })
    // Not executable on purpose: finalize must chmod before probing.
    await writeFile(join(dir, SERVER), '#!/bin/sh\necho server\n')
    await writeFile(join(dir, CLI), "#!/bin/sh\necho 'usage: sd-cli [options]'\necho '  --cfg-scale SCALE'\n")
    const log: string[] = []
    const written = await finalizeBackendInstall(root, args(dir, { sha256: 'ff' }), {
      now: () => 4242,
      log: (_level, msg) => log.push(msg),
    })
    expect(written).toEqual({
      tag: 'tag',
      backendId: 'cpu',
      backend: 'cpu',
      engine: 'sd-cpp',
      sha256: 'ff',
      installedAtMs: 4242,
      dir,
    })
    expect(await readInstallRecord(dir)).toEqual(written)
    expect(await listInstalledBackends(root)).toHaveLength(1)
    expect((await stat(join(dir, SERVER))).mode & 0o111).toBe(0o111)
    expect(log.some((line) => line.startsWith('engine probe passed in '))).toBe(true)

    // A binary that is not sd.cpp fails the probe and leaves no record; without a CLI the server is probed.
    const bad = join(root, 'tag', 'bad')
    await mkdir(bad, { recursive: true })
    await writeFile(join(bad, SERVER), "#!/bin/sh\necho 'llama-server usage'\n")
    const error = await refusal(
      finalizeBackendInstall(root, args(bad, { backendId: 'bad' }), { log: (_l, m) => log.push(m) })
    )
    expect(error.toJSON()).toEqual({
      code: 'ENGINE_INSTALL_FAILED',
      message: 'The downloaded binary is not stable-diffusion.cpp.',
      details: 'llama-server usage\n',
    })
    expect(await isOwned(bad)).toBe(false)
    expect(log.at(-1)).toContain('engine probe failed after ')
    expect(log.at(-1)).toContain('The downloaded binary is not stable-diffusion.cpp.')
  })
})

describe.skipIf(!posix)('probeBinary', () => {
  it('gives up on a binary that never answers, and kills it', async () => {
    const hung = join(root, 'hung')
    // `exec` so the kill lands on the sleeper, not on a shell above it.
    await script(hung, 'exec sleep 30')
    const started = Date.now()
    const error = await refusal(probeBinary(hung, { probeTimeoutMs: 300, spawnRetryDelayMs: 0 }))
    expect(error.code).toBe('ENGINE_INSTALL_FAILED')
    expect(error.message).toBe('The image engine did not respond to --help.')
    expect(error.details).toBe(`${hung} timed out after 0s`)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('retries a binary that cannot be spawned yet', async () => {
    const cli = join(root, 'sd-cli')
    await script(cli, "echo '  --cfg-scale SCALE'", 0o644)
    const unlock = new Promise<void>((resolve) =>
      setTimeout(() => void chmod(cli, 0o755).then(() => resolve()), 100)
    )
    const log: string[] = []
    await probeBinary(cli, { probeTimeoutMs: 30_000, spawnRetryDelayMs: 400, log: (_l, m) => log.push(m) })
    await unlock
    expect(log[0]).toContain('engine probe did not start (attempt 1/3)')

    // One that never becomes runnable fails once the attempts run out.
    const locked = join(root, 'locked')
    await script(locked, "echo '  --cfg-scale SCALE'", 0o644)
    const error = await refusal(probeBinary(locked, { probeTimeoutMs: 30_000, spawnRetryDelayMs: 0 }))
    expect(error.code).toBe('ENGINE_INSTALL_FAILED')
    expect(error.message).toBe('The image engine could not be started.')
    expect(error.details).toContain(locked)
  })

  it('reads the marker from either stream', async () => {
    const onStderr = join(root, 'on-stderr')
    await script(onStderr, "echo 'stable-diffusion.cpp version 1' 1>&2; exit 1")
    await expect(probeBinary(onStderr, { spawnRetryDelayMs: 0 })).resolves.toBeUndefined()
  })
})

describe('the small helpers', () => {
  it('know the probe markers', () => {
    expect(probeOutputIsSdcpp('stable-diffusion.cpp v1')).toBe(true)
    expect(probeOutputIsSdcpp('  --cfg-scale SCALE  unconditional guidance')).toBe(true)
    expect(probeOutputIsSdcpp('usage: llama-server')).toBe(false)
  })

  it('name the binaries per platform', () => {
    expect([serverBinaryName('win32'), cliBinaryName('win32')]).toEqual(['sd-server.exe', 'sd-cli.exe'])
    expect([serverBinaryName('linux'), cliBinaryName('darwin')]).toEqual(['sd-server', 'sd-cli'])
  })

  it('create the folders, and report the one they cannot', async () => {
    await ensureDirs([join(root, 'a', 'b'), join(root, 'c')])
    expect(await exists(join(root, 'a', 'b'))).toBe(true)
    await writeFile(join(root, 'file'), 'x')
    const error = await refusal(ensureDirs([join(root, 'file', 'sub')]))
    expect(error.message).toBe('Could not create the diffusion folders.')
  })
})
