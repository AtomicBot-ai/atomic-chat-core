import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeWindows, type FakeWindowsMachine } from '../../../test/helpers/fake-windows-host.js'
import { guestStoreMigrationFs, migrateTensorrtLlmModels, nodeStoreMigrationFs } from './migrate.js'

/**
 * Moving TensorRT-LLM's models into the shared store (change `add-vllm-runtime`, design D5; spec
 * `managed-model-store`, "Модели TensorRT-LLM переезжают в общий корень"): a rename per model folder,
 * never a copy, never over an id already in the store, never a folder without `model.yml`.
 */
let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'store-migration-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const legacy = () => join(dir, 'tensorrt-llm', 'models')
const store = () => join(dir, 'managed-models')

async function model(root: string, id: string, extra: Record<string, string> = {}): Promise<string> {
  const folder = join(root, ...id.split('/'))
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'model.yml'), `repository: ${id}\nquantization: fp8\n`)
  await writeFile(join(folder, 'model.safetensors'), 'weights')
  for (const [name, text] of Object.entries(extra)) await writeFile(join(folder, name), text)
  return folder
}

describe('migrateTensorrtLlmModels on Linux', () => {
  it('Обновление с двумя моделями TRT: both move under their ids, the old root goes once empty', async () => {
    await model(legacy(), 'Qwen/Qwen3.5-2B')
    await model(legacy(), 'acme/m', { 'config.json': '{}' })

    const result = await migrateTensorrtLlmModels({ from: legacy(), to: store(), fs: nodeStoreMigrationFs })

    expect(result).toEqual({
      from: legacy(),
      to: store(),
      moved: ['Qwen/Qwen3.5-2B', 'acme/m'],
      conflicts: [],
    })
    expect(await readFile(join(store(), 'acme', 'm', 'config.json'), 'utf8')).toBe('{}')
    expect(existsSync(join(store(), 'Qwen', 'Qwen3.5-2B', 'model.yml'))).toBe(true)
    expect(existsSync(legacy())).toBe(false)
  })

  it('Скачивание, прерванное до обновления: a folder without model.yml stays where it is, and so does the root', async () => {
    await mkdir(join(legacy(), 'half', 'done'), { recursive: true })
    await writeFile(join(legacy(), 'half', 'done', 'model-00001.safetensors'), 'part')

    const result = await migrateTensorrtLlmModels({ from: legacy(), to: store(), fs: nodeStoreMigrationFs })

    expect(result.moved).toEqual([])
    expect(existsSync(join(legacy(), 'half', 'done', 'model-00001.safetensors'))).toBe(true)
    expect(existsSync(join(store(), 'half'))).toBe(false)
  })

  it('Конфликт id: both folders stay as they are and the conflict is reported', async () => {
    const source = await model(legacy(), 'acme/m', { 'a.txt': 'old' })
    const target = await model(store(), 'acme/m', { 'a.txt': 'new' })
    await model(legacy(), 'acme/other')

    const result = await migrateTensorrtLlmModels({ from: legacy(), to: store(), fs: nodeStoreMigrationFs })

    expect(result.moved).toEqual(['acme/other'])
    expect(result.conflicts).toEqual([{ model_id: 'acme/m', source, target }])
    expect(await readFile(join(source, 'a.txt'), 'utf8')).toBe('old')
    expect(await readFile(join(target, 'a.txt'), 'utf8')).toBe('new')
  })

  it('leaves a folder it did not move exactly as it was, empty subfolders included', async () => {
    const source = await model(legacy(), 'acme/m')
    await mkdir(join(source, 'checkpoints'), { recursive: true })
    await model(store(), 'acme/m')
    await mkdir(join(legacy(), 'half', 'onnx'), { recursive: true })
    await writeFile(join(legacy(), 'half', 'part.safetensors'), 'part')
    await model(legacy(), 'acme/other')

    await migrateTensorrtLlmModels({ from: legacy(), to: store(), fs: nodeStoreMigrationFs })

    expect(existsSync(join(source, 'checkpoints'))).toBe(true)
    expect(existsSync(join(legacy(), 'half', 'onnx'))).toBe(true)
    expect(existsSync(join(store(), 'acme', 'other', 'model.yml'))).toBe(true)
  })

  it('is a no-op on every later start, and without an old root at all', async () => {
    await model(legacy(), 'acme/m')
    await migrateTensorrtLlmModels({ from: legacy(), to: store(), fs: nodeStoreMigrationFs })
    expect(await migrateTensorrtLlmModels({ from: legacy(), to: store(), fs: nodeStoreMigrationFs })).toEqual(
      {
        from: legacy(),
        to: store(),
        moved: [],
        conflicts: [],
      }
    )
  })
})

describe('migrateTensorrtLlmModels in the WSL guest (fake wsl.exe)', () => {
  const LEGACY = '/var/lib/atomic-chat/scopes/k1/models/tensorrt-llm'
  const STORE = '/var/lib/atomic-chat/scopes/k1/managed-models'
  const machine = (files: Record<string, string>): FakeWindowsMachine =>
    ({
      wsl: {
        installed: true,
        distributions: [{ name: 'AtomicChat', version: 2, state: 'Running', default: false }],
        guests: { AtomicChat: { files, dirs: [], host: { driver: null, docker: {}, toolkit: false } } },
      },
    }) as unknown as FakeWindowsMachine

  it('moves each model folder with mv in the guest, and leaves a conflict and a half download alone', async () => {
    const m = machine({
      [`${LEGACY}/acme/m/model.yml`]: 'repository: acme/m\n',
      [`${LEGACY}/acme/m/model.safetensors`]: 'w',
      [`${LEGACY}/acme/taken/model.yml`]: 'repository: acme/taken\n',
      [`${STORE}/acme/taken/model.yml`]: 'repository: acme/taken\n',
      [`${LEGACY}/half/model-00001.safetensors`]: 'part',
    })
    const windows = fakeWindows(m)
    const transport = windows.wsl.distribution('AtomicChat')

    const result = await migrateTensorrtLlmModels({
      from: LEGACY,
      to: STORE,
      fs: guestStoreMigrationFs(transport),
    })

    expect(result.moved).toEqual(['acme/m'])
    expect(result.conflicts).toEqual([
      { model_id: 'acme/taken', source: `${LEGACY}/acme/taken`, target: `${STORE}/acme/taken` },
    ])
    const files = m.wsl.guests?.['AtomicChat']?.files ?? {}
    expect(Object.keys(files).sort()).toEqual(
      [
        `${LEGACY}/acme/taken/model.yml`,
        `${LEGACY}/half/model-00001.safetensors`,
        `${STORE}/acme/m/model.safetensors`,
        `${STORE}/acme/m/model.yml`,
        `${STORE}/acme/taken/model.yml`,
      ].sort()
    )
    // Every command ran as root in the guest, as argv — never through a shell.
    const guestCalls = windows.wslCalls.filter((argv) => argv[0] === '-d')
    expect(guestCalls.every((argv) => argv.slice(0, 5).join(' ') === '-d AtomicChat -u root --exec')).toBe(
      true
    )
    expect(guestCalls.some((argv) => argv.includes('sh') || argv.includes('bash'))).toBe(false)
  })
})
