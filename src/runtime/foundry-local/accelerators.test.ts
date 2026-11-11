import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { FoundryLocalAcceleratorsEvent } from '../../contracts/index.js'
import { FoundryLocalAcceleratorService } from './accelerators.js'

vi.setConfig({ testTimeout: 20_000 })
const POSIX = process.platform !== 'win32'
const FAKE_HOST = fileURLToPath(new URL('../../../test/helpers/fake-foundry-host.mjs', import.meta.url))

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-foundry-accelerators-')
})
afterEach(() => data.cleanup())

function service(
  opts: {
    eps?: string
    fail?: string
    mode?: string
    build?: () => Promise<string | undefined>
    cuda?: {
      supports(build: string): boolean
      prepare(build: string, progress: (fraction: number) => void): Promise<string | undefined>
    }
  } = {}
) {
  const events: FoundryLocalAcceleratorsEvent[] = []
  const argvFile = join(data.root, 'argv.jsonl')
  const paths = data.layout.provider('foundry-local')
  const accelerators = new FoundryLocalAcceleratorService({
    hostCommand: { exe: process.execPath, args: [FAKE_HOST] },
    resolveBuild: opts.build ?? (async () => join(paths.backendsDir, 'v2.1.0', 'linux-x64')),
    runtimeDir: paths.runtimeDir as string,
    logsDir: paths.logsDir as string,
    emit: (_name, payload) => void events.push(payload),
    env: {
      ...process.env,
      FAKE_FOUNDRY_ARGV: argvFile,
      FAKE_FOUNDRY_EPS: opts.eps ?? 'WebGpuExecutionProvider,CUDAExecutionProvider',
      FAKE_FOUNDRY_FAIL: opts.fail ?? '',
      FAKE_FOUNDRY_MODE: opts.mode ?? 'ready',
    },
    now: () => 1_000,
    ...(opts.cuda ? { cuda: opts.cuda } : {}),
  })
  const probes = async () =>
    existsSync(argvFile)
      ? (await readFile(argvFile, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => (JSON.parse(line) as { argv: string[] }).argv)
          .filter((argv) => argv[0] === 'probe')
      : []
  return { accelerators, events, probes, paths }
}

describe.skipIf(!POSIX)('FoundryLocalAcceleratorService (task 6.4)', () => {
  it('keeps legacy preparation and errors on 2.1.0, isolates 2.4.0, and restores them on rollback', async () => {
    let tag = 'v2.1.0'
    const { accelerators, paths } = service({
      fail: 'CUDAExecutionProvider',
      build: async () => join(data.layout.provider('foundry-local').backendsDir, tag, 'linux-x64'),
    })
    await accelerators.prepare({})
    const legacy = await readFile(join(paths.runtimeDir!, 'accelerators.json'), 'utf8')
    tag = 'v2.4.0'
    expect(await accelerators.prepared()).toEqual([])
    const newer = await accelerators.list()
    expect(newer.accelerators.every((ep) => !ep.prepared && ep.reason === undefined)).toBe(true)
    await accelerators.prepare({ accelerators: ['CUDAExecutionProvider'] })
    expect(await readFile(join(paths.runtimeDir!, 'accelerators.json'), 'utf8')).toBe(legacy)
    tag = 'v2.1.0'
    expect(await accelerators.prepared()).toEqual(['WebGpuExecutionProvider'])
    expect(
      (await accelerators.list()).accelerators.find((ep) => ep.name === 'CUDAExecutionProvider')?.reason
    ).toContain('libcublasLt')
  })

  it('writes a late preparation result to the original build even after active changes', async () => {
    let tag = 'v2.1.0'
    let announce: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      announce = resolve
    })
    const { accelerators } = service({
      build: async () => {
        const original = tag
        announce()
        return join(data.layout.provider('foundry-local').backendsDir, original, 'linux-x64')
      },
    })
    const preparing = accelerators.prepare({ accelerators: ['WebGpuExecutionProvider'] })
    await started
    tag = 'v2.4.0'
    await preparing
    expect(await accelerators.prepared()).toEqual([])
    tag = 'v2.1.0'
    expect(await accelerators.prepared()).toEqual(['WebGpuExecutionProvider'])
  })

  it('probes the active build on the first request and answers from that probe until the build changes', async () => {
    let build = 'v2.1.0'
    const { accelerators, probes, paths } = service({
      build: async () => join(data.layout.provider('foundry-local').backendsDir, build, 'linux-x64'),
    })
    const first = await accelerators.list()
    expect(first).toEqual({
      installed: true,
      build: 'v2.1.0/linux-x64',
      version: '2.1.0',
      c_api_version: 2,
      probed_at: 1_000,
      accelerators: [
        { name: 'WebGpuExecutionProvider', execution_provider: 'webgpu', device: 'gpu', prepared: false },
        { name: 'CUDAExecutionProvider', execution_provider: 'cuda', device: 'gpu', prepared: false },
      ],
      error: null,
    })
    await accelerators.list()
    expect(await probes()).toHaveLength(1)
    expect((await probes())[0]).toEqual(
      expect.arrayContaining(['--app-data', paths.runtimeDir, '--logs', paths.logsDir])
    )
    // An install or update makes another build active: the next request probes it.
    build = 'v2.2.0'
    expect((await accelerators.list()).build).toBe('v2.2.0/linux-x64')
    expect(await probes()).toHaveLength(2)
    await accelerators.list({ force: true })
    expect(await probes()).toHaveLength(3)
  })

  it('answers not installed without starting a host, and the probe failure as an error', async () => {
    const none = service({ build: async () => undefined })
    expect(await none.accelerators.list()).toMatchObject({
      installed: false,
      build: null,
      accelerators: [],
      error: null,
    })
    expect(await none.probes()).toEqual([])
    const broken = service({ mode: 'exit-3' })
    expect(await broken.accelerators.list()).toMatchObject({
      installed: true,
      accelerators: [],
      error: expect.stringContaining('libatomic.so.1'),
    })
  })

  it('prepares, publishes each step, keeps going past a failure, records the outcome and re-probes with it', async () => {
    const { accelerators, events, probes, paths } = service({ fail: 'CUDAExecutionProvider' })
    await accelerators.list()
    const result = await accelerators.prepare({})
    expect(result).toEqual({
      accelerators: [
        { name: 'WebGpuExecutionProvider', prepared: true },
        {
          name: 'CUDAExecutionProvider',
          prepared: false,
          reason: expect.stringContaining('libcublasLt.so.12'),
        },
      ],
    })
    expect(events).toEqual([
      { accelerator: 'WebGpuExecutionProvider', stage: 'started', fraction: 0 },
      { accelerator: 'WebGpuExecutionProvider', stage: 'downloading', fraction: 0.5 },
      { accelerator: 'WebGpuExecutionProvider', stage: 'done', fraction: 1 },
      { accelerator: 'CUDAExecutionProvider', stage: 'started', fraction: 0 },
      {
        accelerator: 'CUDAExecutionProvider',
        stage: 'failed',
        fraction: null,
        reason: expect.stringContaining('libcublasLt'),
      },
    ])
    expect(
      JSON.parse(await readFile(join(paths.runtimeDir as string, 'accelerators.json'), 'utf8'))
    ).toMatchObject({
      prepared: ['WebGpuExecutionProvider'],
      failures: { CUDAExecutionProvider: expect.stringContaining('libcublasLt') },
    })
    expect(await accelerators.prepared()).toEqual(['WebGpuExecutionProvider'])
    const after = await accelerators.list()
    expect(after.accelerators).toEqual([
      { name: 'WebGpuExecutionProvider', execution_provider: 'webgpu', device: 'gpu', prepared: true },
      {
        name: 'CUDAExecutionProvider',
        execution_provider: 'cuda',
        device: 'gpu',
        prepared: false,
        reason: expect.stringContaining('libcublasLt'),
      },
    ])
    expect((await probes()).at(-1)).toEqual(expect.arrayContaining(['--prepared', 'WebGpuExecutionProvider']))
  })

  it('fetches NVIDIA libraries only for an offered CUDA prepare', async () => {
    const cuda = { supports: () => true, prepare: vi.fn(async () => 'C:\\atomic-cuda') }
    const { accelerators } = service({ cuda })
    await accelerators.list()
    await accelerators.prepare({ accelerators: ['WebGpuExecutionProvider'] })
    expect(cuda.prepare).not.toHaveBeenCalled()
    const absent = service({ cuda, eps: 'WebGpuExecutionProvider' })
    await absent.accelerators.prepare({ accelerators: ['CUDAExecutionProvider'] })
    expect(cuda.prepare).not.toHaveBeenCalled()
    expect((await accelerators.prepare({ accelerators: ['CUDAExecutionProvider'] })).accelerators).toEqual([
      { name: 'CUDAExecutionProvider', prepared: true },
    ])
    expect(cuda.prepare).toHaveBeenCalledOnce()
  })

  it('records NVIDIA download failure and still prepares other accelerators', async () => {
    const cuda = {
      supports: () => true,
      prepare: vi.fn(async () => {
        throw new Error('bad digest')
      }),
    }
    const { accelerators, events } = service({ cuda })
    const result = await accelerators.prepare({})
    expect(result.accelerators).toEqual([
      { name: 'WebGpuExecutionProvider', prepared: true },
      { name: 'CUDAExecutionProvider', prepared: false, reason: expect.stringContaining('bad digest') },
    ])
    expect(await accelerators.prepared()).toEqual(['WebGpuExecutionProvider'])
    expect(events).toContainEqual(
      expect.objectContaining({ accelerator: 'CUDAExecutionProvider', stage: 'failed' })
    )
  })

  it('runs one prepare at a time, and needs an installed build', async () => {
    const { accelerators } = service()
    const first = accelerators.prepare({ accelerators: ['WebGpuExecutionProvider'] })
    await expect(accelerators.prepare({})).rejects.toMatchObject({ code: 'ENGINE_INSTALL_IN_PROGRESS' })
    await first
    await expect(service({ build: async () => undefined }).accelerators.prepare({})).rejects.toMatchObject({
      code: 'BINARY_NOT_FOUND',
    })
  })

  it('forgets an accelerator that a later prepare could not prepare again', async () => {
    const { accelerators } = service()
    await accelerators.prepare({ accelerators: ['CUDAExecutionProvider'] })
    expect(await accelerators.prepared()).toEqual(['CUDAExecutionProvider'])
    const again = service({ fail: 'CUDAExecutionProvider' })
    await again.accelerators.prepare({ accelerators: ['CUDAExecutionProvider'] })
    expect(await again.accelerators.prepared()).toEqual([])
  })
})
