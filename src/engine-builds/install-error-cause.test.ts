import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { c as tarCreate } from 'tar'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import { AtomicCoreError } from '../contracts/index.js'
import { DOWNLOAD_CANCELLED, HASH_MISMATCH_MESSAGE } from '../downloads/index.js'
import {
  ErrorReporter,
  classifyFailure,
  diagnosticTags,
  errorChain,
  failureObserver,
  internalErrorReport,
} from '../telemetry/index.js'
import { installStaged } from './install.js'
import type { StagedInstall } from './install.js'

let data: TmpDataFolder
let archivePath: string

beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-staged-install-cause-')
  const src = join(data.root, 'src-archive')
  await mkdir(src, { recursive: true })
  await writeFile(join(src, 'engine-bin'), 'binary')
  archivePath = join(data.root, 'engine.tar.gz')
  await tarCreate({ gzip: true, cwd: src, file: archivePath }, ['engine-bin'])
})

afterEach(async () => {
  await data.cleanup()
})

function makePlan(overrides: Partial<StagedInstall> = {}): StagedInstall {
  return {
    dataFolder: data.root,
    target: join(data.root, 'engines', 'v1', 'win-x64'),
    archives: [
      { url: 'https://example.test/engine.tar.gz', name: 'engine.tar.gz', sha256: 'abc', size: 100 },
    ],
    taskId: 'install-task',
    downloader: {
      download: async (_taskId, items) => {
        for (const item of items) await writeFile(item.save_path, await readFile(archivePath))
      },
    },
    availableSpace: async () => 10_000,
    now: () => 42,
    verify: async () => {},
    record: async () => {},
    ...overrides,
  }
}

describe('installStaged error cause preservation', () => {
  it('preserves the underlying error cause across installStaged failure branches', async () => {
    const eperm = Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
    const stageErr = await installStaged(
      makePlan({
        record: async () => {
          throw eperm
        },
      })
    ).catch((error: unknown) => error)

    expect(stageErr).toBeInstanceOf(AtomicCoreError)
    const coreStageErr = stageErr as AtomicCoreError
    expect(coreStageErr.toJSON()).toEqual({
      code: 'ENGINE_INSTALL_FAILED',
      message: 'Could not install the engine build.',
      details: String(eperm),
    })
    expect(coreStageErr.cause).toBe(eperm)
    expect(errorChain(coreStageErr)).toEqual([coreStageErr, eperm])

    const stageDiag = classifyFailure(coreStageErr, { component: 'http', operation: 'request' })
    expect(stageDiag).toMatchObject({
      component: 'http',
      operation: 'request',
      category: 'operational',
      reason: 'disk_permission',
    })
    expect(diagnosticTags(coreStageErr, stageDiag)).toMatchObject({
      failure_category: 'operational',
      failure_reason: 'disk_permission',
      cause_code: 'EPERM',
      diagnostic_cause_code: 'EPERM',
    })

    // Unpack failure preserves the archive extraction cause.
    const unpackErr = await installStaged(
      makePlan({
        downloader: {
          download: async (_taskId, items) => {
            for (const item of items) await writeFile(item.save_path, 'not-a-valid-gzip')
          },
        },
      })
    ).catch((error: unknown) => error)
    expect(unpackErr).toBeInstanceOf(AtomicCoreError)
    expect((unpackErr as AtomicCoreError).code).toBe('ENGINE_INSTALL_FAILED')
    expect((unpackErr as AtomicCoreError).message).toBe('Could not unpack the engine archive.')
    expect((unpackErr as AtomicCoreError).cause).toBeInstanceOf(Error)

    // Download failure preserves the underlying downloader error and deduplicates across control_route.
    const enospc = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    const downloadUnderlying = Object.defineProperty(
      new Error('Error: [disk_full] Not enough free disk space', { cause: enospc }),
      'diagnostic',
      {
        value: Object.freeze({
          component: 'downloads',
          operation: 'download',
          stage: 'validate',
          reason: 'disk_full',
          category: 'operational',
        }),
      }
    )

    const sent: Array<Record<string, unknown>> = []
    const reporter = new ErrorReporter({
      config: {
        dsn: {
          dsn: 'https://example.test/42',
          publicKey: 'fixture',
          host: 'example.test',
          projectId: '42',
          envelopeUrl: 'https://example.test/api/42/envelope/',
        },
        environment: 'production',
        release: 'atomic-chat-core@0.21.4',
      },
      coreVersion: '0.21.4',
      platform: 'win32',
      arch: 'x64',
      ownerScope: 'app',
      host: 'atomic-chat',
      enabled: true,
      fetch: vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const lines = String(init?.body).split('\n')
        sent.push(JSON.parse(lines[2] ?? '{}'))
        return new Response(null, { status: 200 })
      }) as unknown as typeof globalThis.fetch,
    })
    const onFailure = failureObserver(reporter)

    const downloadErr = await installStaged(
      makePlan({
        downloader: {
          download: async () => {
            onFailure(downloadUnderlying, { component: 'downloads', operation: 'download' })
            throw downloadUnderlying
          },
        },
      })
    ).catch((error: unknown) => error)

    expect(downloadErr).toBeInstanceOf(AtomicCoreError)
    expect((downloadErr as AtomicCoreError).cause).toBe(downloadUnderlying)
    const routeReport = internalErrorReport({
      source: 'control_route',
      error: downloadErr,
      status: 500,
      route: 'POST /atomic/v1/engine-builds/:engine/install',
    })
    if (routeReport) reporter.capture(routeReport)
    await reporter.flush()
    expect(sent).toHaveLength(1)
    expect(sent[0]?.['tags']).toMatchObject({
      component: 'downloads',
      operation: 'download',
      failure_category: 'operational',
      failure_reason: 'disk_full',
      cause_code: 'ENOSPC',
    })

    // Hash mismatch and cancellation also preserve cause.
    const mismatchCause = new Error(HASH_MISMATCH_MESSAGE)
    const mismatchErr = await installStaged(
      makePlan({
        downloader: {
          download: async () => {
            throw mismatchCause
          },
        },
      })
    ).catch((error: unknown) => error)
    expect((mismatchErr as AtomicCoreError).cause).toBe(mismatchCause)

    const cancelCause = new Error(DOWNLOAD_CANCELLED)
    const cancelErr = await installStaged(
      makePlan({
        downloader: {
          download: async () => {
            throw cancelCause
          },
        },
      })
    ).catch((error: unknown) => error)
    expect((cancelErr as AtomicCoreError).code).toBe('CANCELLED')
    expect((cancelErr as AtomicCoreError).cause).toBe(cancelCause)
  })
})
