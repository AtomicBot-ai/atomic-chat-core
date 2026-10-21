import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeZip } from '../../../test/helpers/make-zip.js'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { LiteRtLmAcceleratorsEvent, LiteRtLmNpu } from '../../contracts/index.js'
import type { LiteRtLmRelease } from '../../engine-builds/manifest.js'
import { LiteRtLmAcceleratorService } from './accelerators.js'
import type { LiteRtLmAcceleratorDeps } from './accelerators.js'

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-litert-acc-')
})
afterEach(() => data.cleanup())

const WHEEL = makeZip([
  { name: 'openvino/__init__.py', data: Buffer.from('py') },
  { name: 'openvino/libs/openvino.dll', data: Buffer.from('ov') },
  { name: 'openvino/libs/openvino_intel_npu_plugin.dll', data: Buffer.from('npu') },
  { name: 'openvino/tools/ovc.py', data: Buffer.from('py') },
  { name: 'openvino-2026.4.1.dist-info/RECORD', data: Buffer.from('r') },
])
const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex')

function release(over: { sha256?: string } = {}): LiteRtLmRelease {
  return {
    version: '0.18.1',
    published_at: '2026-10-19T22:44:33Z',
    min_core_version: '0.1.0',
    abi: 1,
    assets: [],
    accelerators: [
      {
        id: 'openvino',
        platform: 'win-x64',
        version: '2026.4.1',
        url: 'https://files.pythonhosted.org/packages/d0/openvino-2026.4.1-22982-cp312-cp312-win_amd64.whl',
        name: 'openvino-2026.4.1-22982-cp312-cp312-win_amd64.whl',
        size: WHEEL.length,
        sha256: over.sha256 ?? sha(WHEEL),
      },
    ],
  }
}

function service(over: Partial<LiteRtLmAcceleratorDeps> & { generation?: LiteRtLmNpu | null } = {}) {
  const events: LiteRtLmAcceleratorsEvent[] = []
  const downloads: string[] = []
  const paths = data.layout.provider('litert-lm')
  const { generation, ...rest } = over
  const svc = new LiteRtLmAcceleratorService({
    acceleratorsDir: paths.acceleratorsDir as string,
    tmpDir: paths.tmpDir,
    resolveBuild: async () => ({ dir: join(paths.backendsDir, '0.18.1', 'win-x64'), version: '0.18.1' }),
    release: async () => release(),
    npuGeneration: async () => (generation === undefined ? 'intel-lnl' : generation),
    download: async (_task, item, onFraction) => {
      downloads.push(item.url)
      onFraction(0.5)
      await writeFile(item.save_path, WHEEL)
      if (item.sha256 !== sha(WHEEL)) throw new Error('Hash verification failed')
      onFraction(1)
    },
    emit: (_name, payload) => void events.push(payload),
    ...rest,
  })
  return { svc, events, downloads, dir: join(paths.acceleratorsDir as string, 'openvino', '2026.4.1') }
}

describe('LiteRtLmAcceleratorService (task 6.4)', () => {
  it('offers OpenVINO on a machine with an Intel NPU LiteRT-LM targets, unprepared at first', async () => {
    const { svc } = service()
    expect(await svc.list()).toEqual({
      installed: true,
      build: '0.18.1/win-x64',
      npu: 'intel-lnl',
      accelerators: [
        { name: 'openvino', device: 'npu', version: '2026.4.1', size_bytes: WHEEL.length, prepared: false },
      ],
      error: null,
    })
    expect(await svc.libsDir()).toBeUndefined()
  })

  it('offers nothing without an Intel NPU it has files for, or without a build', async () => {
    expect(await service({ generation: null }).svc.list()).toMatchObject({ npu: null, accelerators: [] })
    expect(await service({ resolveBuild: async () => undefined }).svc.list()).toEqual({
      installed: false,
      build: null,
      npu: null,
      accelerators: [],
      error: null,
    })
  })

  it('prepares: downloads with progress, unpacks only openvino/libs, and a second prepare downloads nothing', async () => {
    const { svc, events, downloads, dir } = service()
    expect(await svc.prepare({})).toEqual({ accelerators: [{ name: 'openvino', prepared: true }] })
    expect(events).toEqual([
      { accelerator: 'openvino', stage: 'started', fraction: 0 },
      { accelerator: 'openvino', stage: 'downloading', fraction: 0.5 },
      { accelerator: 'openvino', stage: 'downloading', fraction: 1 },
      { accelerator: 'openvino', stage: 'done', fraction: 1 },
    ])
    expect((await readdir(dir)).sort()).toEqual([
      '.atomic-owned',
      'openvino.dll',
      'openvino_intel_npu_plugin.dll',
    ])
    expect(await readFile(join(dir, 'openvino.dll'), 'utf8')).toBe('ov')
    expect(await svc.libsDir()).toBe(dir)
    expect((await svc.list()).accelerators[0]?.prepared).toBe(true)

    events.length = 0
    expect(await svc.prepare({ accelerators: ['openvino'] })).toEqual({
      accelerators: [{ name: 'openvino', prepared: true }],
    })
    expect(downloads).toHaveLength(1)
    expect(events).toEqual([{ accelerator: 'openvino', stage: 'done', fraction: 1 }])
  })

  it('fails a wheel whose sha256 differs from conf: nothing unpacked, the reason kept', async () => {
    const { svc, events, dir } = service({ release: async () => release({ sha256: 'a'.repeat(64) }) })
    const result = await svc.prepare({})
    expect(result.accelerators[0]).toMatchObject({
      name: 'openvino',
      prepared: false,
      reason: expect.stringMatching(/Hash/),
    })
    expect(events.at(-1)).toMatchObject({ stage: 'failed', fraction: null })
    expect(existsSync(dir)).toBe(false)
    expect((await svc.list()).accelerators[0]).toMatchObject({
      prepared: false,
      reason: expect.stringMatching(/Hash/),
    })
  })

  it('says why for a name it does not offer, and runs one prepare at a time', async () => {
    const { svc } = service({ generation: null })
    expect(await svc.prepare({ accelerators: ['openvino', 'cuda'] })).toEqual({
      accelerators: [
        { name: 'openvino', prepared: false, reason: expect.stringMatching(/Intel NPU/) },
        { name: 'cuda', prepared: false, reason: expect.stringMatching(/cuda/) },
      ],
    })
    let release!: () => void
    const slow = service({
      download: async (_task, item) => {
        await new Promise<void>((resolve) => (release = resolve))
        await writeFile(item.save_path, WHEEL)
      },
    }).svc
    const first = slow.prepare({})
    await new Promise((resolve) => setTimeout(resolve, 10))
    await expect(slow.prepare({})).rejects.toMatchObject({ code: 'ENGINE_INSTALL_IN_PROGRESS' })
    release()
    expect((await first).accelerators[0]?.prepared).toBe(true)
  })
})
