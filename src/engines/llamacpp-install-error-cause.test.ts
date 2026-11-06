import { describe, expect, it, vi } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import type { BackendCatalogResponse, BackendUpdateCheckResponse } from '../contracts/index.js'
import { DOWNLOAD_CANCELLED } from '../downloads/index.js'
import {
  ErrorReporter,
  classifyFailure,
  diagnosticTags,
  errorChain,
  failureObserver,
  internalErrorReport,
} from '../telemetry/index.js'
import { LlamacppEngine } from './llamacpp.js'

const PROVIDER = 'llamacpp-upstream'

function makeEngine(
  installImpl: () => Promise<{ version: string; backend: string; installed: boolean; path: string }>
) {
  const current = 'b11443/macos-arm64'
  const offer = 'b11500/macos-arm64'
  const backends = {
    operate: async <T>(_op: 'install' | 'update' | 'uninstall', fn: (op: never) => Promise<T>) =>
      fn({ id: 'op-test' } as never),
    install: installImpl,
  }
  const advisor = {
    checkUpdates: async (): Promise<BackendUpdateCheckResponse> => ({
      provider: PROVIDER,
      current,
      current_kind: 'concrete',
      update_needed: true,
      new_version: 'b11500',
      target_backend: offer,
      same_family: true,
      offer,
    }),
    catalog: async () =>
      ({
        provider: PROVIDER,
        available: [
          { version: 'b11500', backend: 'macos-arm64' },
          { version: 'b11443', backend: 'macos-arm64' },
        ],
        source: 'live',
      }) as unknown as BackendCatalogResponse,
  }
  return new LlamacppEngine({
    engine: PROVIDER,
    backends: backends as never,
    advisor: advisor as never,
    currentVersionBackend: () => current,
    selectVersionBackend: async () => {},
    unloadSessions: async () => {},
    emit: () => {},
  })
}

describe('LlamacppEngine.update error cause preservation', () => {
  it('preserves the underlying install error cause across LlamacppEngine.update', async () => {
    const enospc = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    const underlying = Object.defineProperty(
      new Error('Error: [disk_full] moving staged backend into place: ENOSPC', { cause: enospc }),
      'diagnostic',
      {
        value: Object.freeze({
          component: 'backend',
          operation: 'install',
          stage: 'persist',
          reason: 'disk_full',
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
        release: 'atomic-chat-core@0.21.3',
      },
      coreVersion: '0.21.3',
      platform: 'darwin',
      arch: 'x64',
      ownerScope: 'cli',
      host: 'atc',
      enabled: true,
      fetch: vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const lines = String(init?.body).split('\n')
        sent.push(JSON.parse(lines[2] ?? '{}'))
        return new Response(null, { status: 200 })
      }) as unknown as typeof globalThis.fetch,
    })
    const onFailure = failureObserver(reporter)

    const engine = makeEngine(async () => {
      onFailure(underlying, { component: 'backend', operation: 'install' })
      throw underlying
    })

    const caught = await engine.update({ task_id: 'task-test' }).catch((error: unknown) => error)
    expect(caught).toBeInstanceOf(AtomicCoreError)
    const coreError = caught as AtomicCoreError
    expect(coreError.toJSON()).toEqual({
      code: 'ENGINE_INSTALL_FAILED',
      message: 'Error: [disk_full] moving staged backend into place: ENOSPC',
    })
    expect(coreError.cause).toBe(underlying)
    expect(errorChain(coreError)).toEqual([coreError, underlying, enospc])

    const diag = classifyFailure(coreError, { component: 'http', operation: 'request' })
    expect(diag).toMatchObject({
      component: 'backend',
      operation: 'install',
      stage: 'persist',
      category: 'operational',
      reason: 'disk_full',
    })
    expect(diagnosticTags(coreError, diag)).toMatchObject({
      component: 'backend',
      operation: 'install',
      failure_stage: 'persist',
      failure_category: 'operational',
      failure_reason: 'disk_full',
      cause_code: 'ENOSPC',
    })

    const routeReport = internalErrorReport({
      source: 'control_route',
      error: coreError,
      status: 500,
      route: 'POST /atomic/v1/engines/:engine/update',
    })
    if (routeReport) reporter.capture(routeReport)
    await reporter.flush()

    // The backend install boundary already reported `underlying`; preserving `cause` prevents
    // `control_route` from emitting a second uncategorized `ENGINE_INSTALL_FAILED: http request: unknown`.
    expect(sent).toHaveLength(1)
    expect(sent[0]?.['tags']).toMatchObject({
      component: 'backend',
      operation: 'install',
      failure_category: 'operational',
      failure_reason: 'disk_full',
      cause_code: 'ENOSPC',
    })

    const cancelCause = new Error(DOWNLOAD_CANCELLED)
    const cancelEngine = makeEngine(async () => {
      throw cancelCause
    })
    const cancelled = await cancelEngine.update({ task_id: 'task-cancel' }).catch((error: unknown) => error)
    expect(cancelled).toBeInstanceOf(AtomicCoreError)
    expect((cancelled as AtomicCoreError).code).toBe('CANCELLED')
    expect((cancelled as AtomicCoreError).cause).toBe(cancelCause)
  })
})
