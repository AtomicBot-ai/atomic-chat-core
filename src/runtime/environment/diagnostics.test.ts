import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import type { BeginOperation, ManagedPhase, Sha256Digest } from '../../contracts/index.js'
import { FakeManagedFs } from '../../../test/helpers/managed-store-fs.js'
import { buildEnvironmentDiagnostics, documentSource, sourceOverrides } from './diagnostics.js'
import { EnvironmentService } from './service.js'
import { OperationStore } from './store.js'

const DIGEST = `sha256:${'a'.repeat(64)}` as Sha256Digest

const begin = (requestId: string): BeginOperation => ({
  request_id: requestId,
  target: { kind: 'runtime', installation_id: 'inst-1', engine_id: 'tensorrt-llm' },
  kind: 'setup',
  descriptor_id: 'tensorrt-llm-1.3.0rc29-r2',
})

const newStore = (fs: FakeManagedFs): OperationStore => {
  let n = 0
  return new OperationStore({
    root: '/shared',
    instanceId: 'core-1',
    newOperationId: () => `op-${(n += 1)}`,
    newEffectId: () => `effect-${n}`,
    fs,
    now: () => fs.clock,
    sleep: async () => undefined,
    ownerIdentity: async () => ({ pid: 4242, startId: 'test:owner' }),
  })
}

/** Start an operation and move it straight to `phase`, the way a finished setup sits on disk. */
const operationIn = async (
  store: OperationStore,
  requestId: string,
  phase: ManagedPhase
): Promise<string> => {
  const { record } = await store.createOrGet('default', begin(requestId), DIGEST)
  const id = record.machine.operation.operation_id
  const moved = {
    ...record,
    machine: { ...record.machine, operation: { ...record.machine.operation, phase, revision: 1 } },
  }
  expect(await store.compareAndSwap(id, 0, moved)).toBe(true)
  return id
}

describe('archiving finished operations', () => {
  it('moves every finished record and its backup out of the operations directory', async () => {
    const fs = new FakeManagedFs()
    const store = newStore(fs)
    const failed = await operationIn(store, 'req-1', 'failed')
    const cancelled = await operationIn(store, 'req-2', 'cancelled')

    const archived = await store.archiveFinished('2026-10-06T10-00-00')

    expect(archived.ids.sort()).toEqual([cancelled, failed].sort())
    // The store joins with the platform's separator: backslashes on Windows.
    const archive = join('/shared', 'operations-archive', '2026-10-06T10-00-00')
    expect(archived.path).toBe(archive)
    expect(await store.listAll()).toEqual([])
    expect(fs.files.has(join(archive, `${failed}.json`))).toBe(true)
    expect(fs.files.has(join(archive, `${failed}.json.bak`))).toBe(true)
  })

  it('refuses while an operation still runs, and moves nothing', async () => {
    const fs = new FakeManagedFs()
    const store = newStore(fs)
    await operationIn(store, 'req-1', 'failed')
    await operationIn(store, 'req-2', 'pulling-image')

    await expect(store.archiveFinished('t')).rejects.toMatchObject({ code: 'MANAGED_OPERATION_CONFLICT' })
    expect(await store.listAll()).toHaveLength(2)
  })

  it('has nothing to move in an empty directory', async () => {
    expect(await newStore(new FakeManagedFs()).archiveFinished('t')).toEqual({ ids: [], path: null })
  })
})

describe('EnvironmentService.reset', () => {
  const service = (store: OperationStore, onReset: (ids: string[]) => void) =>
    new EnvironmentService({
      store,
      environmentId: 'default',
      instanceId: 'core-1',
      newEffectId: () => 'effect',
      provisioner: null,
      readSnapshot: async () => [],
      onReset,
      resetStamp: () => 'stamp',
    })

  it('archives the finished operations and tells the snapshot to forget them', async () => {
    const store = newStore(new FakeManagedFs())
    const failed = await operationIn(store, 'req-1', 'failed')
    const forgotten: string[][] = []

    const result = await service(store, (ids) => forgotten.push(ids)).reset('default')

    expect(result).toEqual({
      environment_id: 'default',
      archived_operation_ids: [failed],
      archive_path: join('/shared', 'operations-archive', 'stamp'),
    })
    expect(forgotten).toEqual([[failed]])
  })

  it('knows only its own environment', async () => {
    const reset = service(newStore(new FakeManagedFs()), () => undefined).reset('other')
    await expect(reset).rejects.toBeInstanceOf(AtomicCoreError)
  })
})

describe('what a stuck machine shows', () => {
  it('names the variables that move a managed-runtime source, and ignores blank ones', () => {
    expect(
      sourceOverrides({
        ATOMIC_RUNTIME_DESCRIPTOR_URL:
          ' https://raw.githubusercontent.com/x/conf/bbcc7ec/runtimes/tensorrt-llm.json ',
        ATOMIC_ENVIRONMENT_MANIFEST_URL: '  ',
        PATH: '/usr/bin',
      })
    ).toEqual([
      {
        variable: 'ATOMIC_RUNTIME_DESCRIPTOR_URL',
        value: 'https://raw.githubusercontent.com/x/conf/bbcc7ec/runtimes/tensorrt-llm.json',
      },
    ])
  })

  it('reports a document source with its override and what its cache holds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomic-diag-'))
    await writeFile(join(dir, 'latest.json'), '{ "descriptor_id": "tensorrt-llm-1.3.0rc29-r2" }\n')
    await writeFile(join(dir, 'tensorrt-llm-1.3.0rc29-r2.json'), '{}')
    await writeFile(join(dir, 'tensorrt-llm-1.3.0rc29-r3.json'), '{}')
    const input = {
      document: 'runtime-descriptor' as const,
      defaultUrl: 'https://conf/main/tensorrt-llm.json',
      variable: 'ATOMIC_RUNTIME_DESCRIPTOR_URL',
      cacheDir: dir,
      idField: 'descriptor_id',
    }

    expect(
      await documentSource(input, { ATOMIC_RUNTIME_DESCRIPTOR_URL: 'https://conf/pinned.json' })
    ).toEqual({
      document: 'runtime-descriptor',
      url: 'https://conf/pinned.json',
      default_url: 'https://conf/main/tensorrt-llm.json',
      overridden_by: 'ATOMIC_RUNTIME_DESCRIPTOR_URL',
      latest_cached_id: 'tensorrt-llm-1.3.0rc29-r2',
      cached_ids: ['tensorrt-llm-1.3.0rc29-r2', 'tensorrt-llm-1.3.0rc29-r3'],
    })
    expect(await documentSource({ ...input, cacheDir: join(dir, 'missing') }, {})).toMatchObject({
      url: 'https://conf/main/tensorrt-llm.json',
      overridden_by: null,
      latest_cached_id: null,
      cached_ids: [],
    })
  })

  it('summarizes every operation on disk, and survives an unreadable directory', async () => {
    const store = newStore(new FakeManagedFs())
    const failed = await operationIn(store, 'req-1', 'failed')
    const dir = await mkdtemp(join(tmpdir(), 'atomic-diag-'))
    await mkdir(join(dir, 'manifests'))
    const base = {
      now: () => new Date('2026-10-06T10:00:00Z'),
      coreVersion: '0.9.5',
      platform: 'win32',
      arch: 'arm64',
      environment: null,
      env: {},
      documents: [],
      recentWarnings: () => ['w1'],
    }

    const report = await buildEnvironmentDiagnostics({ ...base, operations: () => store.listAll() })
    expect(report).toMatchObject({ generated_at: '2026-10-06T10:00:00.000Z', recent_warnings: ['w1'] })
    expect(report.operations).toEqual([
      expect.objectContaining({ operation_id: failed, phase: 'failed', kind: 'setup', revision: 1 }),
    ])

    const broken = await buildEnvironmentDiagnostics({
      ...base,
      operations: async () => {
        throw new Error('corrupt')
      },
    })
    expect(broken.operations).toEqual([])
  })
})
