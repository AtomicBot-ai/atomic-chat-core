import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import {
  ENGINE_THROTTLE_MS,
  captureReport,
  diffusionFailureReport,
  inferenceFailureReport,
  internalErrorReport,
  loadFailureReport,
  processFailureReport,
  sessionDeathReport,
} from './reports.js'

describe('captureReport', () => {
  it('hands over a report and ignores a null one or a missing sink', () => {
    const captured: unknown[] = []
    const sink = { capture: (r: unknown) => captured.push(r) }
    const report = { source: 'inference' as const, level: 'warning' as const }
    captureReport(sink, report)
    captureReport(sink, null)
    captureReport(undefined, report)
    expect(captured).toEqual([report])
  })
})

describe('processFailureReport', () => {
  it('makes a daemon-killing throw fatal and a listener throw an error', () => {
    const error = new TypeError('x is not a function')
    expect(processFailureReport('uncaught_exception', error)).toMatchObject({
      source: 'uncaught_exception',
      level: 'fatal',
      error,
    })
    expect(processFailureReport('event_listener', error, { event: 'session:died' })).toMatchObject({
      level: 'error',
      tags: { event: 'session:died' },
    })
  })

  it('does not report losing the instance-lock race at start-up', () => {
    const error = new AtomicCoreError('CORE_ALREADY_RUNNING', 'owned')
    expect(processFailureReport('startup', error)).toBeNull()
    expect(processFailureReport('startup', new Error('EADDRINUSE'))?.level).toBe('fatal')
  })
})

describe('internalErrorReport', () => {
  it('reports a plain error behind a 500 with its route', () => {
    const error = new TypeError('boom')
    expect(internalErrorReport({ source: 'control_route', error, status: 500, route: '/x/:id' })).toEqual({
      source: 'control_route',
      level: 'error',
      error,
      tags: { route: '/x/:id', http_status: 500, error_code: undefined },
    })
  })

  it.each([
    ['a coded answer', new AtomicCoreError('INTERNAL_ERROR', 'x'), 500],
    ['a client that hung up', Object.assign(new Error('x'), { code: 'EPIPE' }), 500],
    ['a 4xx', new TypeError('x'), 400],
  ])('ignores %s', (_label, error, status) => {
    expect(internalErrorReport({ source: 'public_server', error, status })).toBeNull()
  })
})

describe('sessionDeathReport', () => {
  const died = { provider: 'llamacpp-upstream' as const, model_id: 'org\\m-Q4_K_M', message: 'crashed' }

  it.each([
    [{ exit_code: null, signal: 'SIGSEGV' }, 'darwin', 'sigsegv', 'error'],
    [{ exit_code: null, signal: 'SIGABRT' }, 'linux', 'sigabrt', 'error'],
    [{ exit_code: 0xc0000005, signal: null }, 'win32', 'native_crash', 'error'],
    [{ exit_code: null, signal: 'SIGKILL' }, 'darwin', 'sigkill', 'warning'],
    [{ exit_code: 1, signal: null }, 'linux', 'exit', 'error'],
  ] as const)('%j on %s is %s', (exit, platform, kind, level) => {
    const report = sessionDeathReport({ ...died, ...exit }, platform)
    expect(report).toMatchObject({
      source: 'backend_crash',
      level,
      type: 'BackendCrash',
      message: 'crashed',
      fingerprint: ['backend-crash', 'llamacpp-upstream', kind],
      tags: { model_id: 'org/m-Q4_K_M', quant: 'Q4_K_M', crash_kind: kind },
      throttle: { windowMs: ENGINE_THROTTLE_MS },
    })
  })

  it('reads an out-of-memory exit as a warning', () => {
    expect(
      sessionDeathReport(
        { ...died, exit_code: 1, signal: null, message: 'CUDA error: out of memory' },
        'linux'
      )?.fingerprint
    ).toEqual(['backend-crash', 'llamacpp-upstream', 'oom'])
  })

  it.each([
    [{ exit_code: null, signal: 'SIGTERM' }],
    [{ exit_code: null, signal: 'SIGINT' }],
    [{ exit_code: 0, signal: null }],
  ])('ignores a polite stop %j', (exit) => {
    expect(sessionDeathReport({ ...died, ...exit }, 'darwin')).toBeNull()
  })
})

describe('loadFailureReport', () => {
  const overrides = {
    version_backend: 'b9179/macos-arm64',
    ctx_size: 8192,
    n_gpu_layers: 99,
    cache_type_k: 'q8_0',
  }

  it('reports an engine failure with its engine context', () => {
    const error = new AtomicCoreError(
      'LLAMA_CPP_PROCESS_ERROR',
      'The model process encountered an unexpected error.',
      'llama_model_load: loading\nGGML_ASSERT(ctx) failed\nprompt: secret'
    )
    const report = loadFailureReport({ provider: 'llamacpp-upstream', modelId: 'a/b-Q4_0', error, overrides })
    expect(report).toEqual({
      source: 'model_load',
      level: 'error',
      error,
      fingerprint: ['model-load-failure', 'llamacpp-upstream', 'LLAMA_CPP_PROCESS_ERROR'],
      tags: {
        provider: 'llamacpp-upstream',
        error_code: 'LLAMA_CPP_PROCESS_ERROR',
        model_id: 'a/b-Q4_0',
        quant: 'Q4_0',
        backend: 'b9179/macos-arm64',
        context_length: 8192,
        gpu_layers: 99,
        cache_type_k: 'q8_0',
        is_embedding: undefined,
        oom_subtype: undefined,
      },
      extra: { engine_errors: 'GGML_ASSERT(ctx) failed' },
      throttle: {
        key: 'load:llamacpp-upstream:a/b-Q4_0:LLAMA_CPP_PROCESS_ERROR',
        windowMs: ENGINE_THROTTLE_MS,
      },
    })
  })

  it('counts environment causes at warning, with the OOM subtype', () => {
    const error = new AtomicCoreError('OUT_OF_MEMORY', 'Out of memory', 'ggml_metal: failed to allocate')
    const report = loadFailureReport({ provider: 'mlx', modelId: 'm', error, isEmbedding: true })
    expect(report).toMatchObject({ level: 'warning', tags: { oom_subtype: 'metal', is_embedding: true } })
  })

  it('reports a plain throw as UNKNOWN without engine lines', () => {
    const report = loadFailureReport({
      provider: 'foundation-models',
      modelId: 'm',
      error: new Error('boom'),
    })
    expect(report?.fingerprint).toEqual(['model-load-failure', 'foundation-models', 'UNKNOWN'])
    expect(report).not.toHaveProperty('extra')
    expect(loadFailureReport({ provider: 'mlx', modelId: 'm', error: 'text' })?.tags?.['error_code']).toBe(
      'UNKNOWN'
    )
  })

  it.each([
    ['MODEL_FILE_NOT_FOUND'],
    ['CPU_NO_AVX'],
    ['MODEL_LOAD_CANCELLED'],
    ['PROVIDER_NOT_FOUND'],
    ['CORE_ALREADY_RUNNING'],
  ])('ignores %s', (code) => {
    const error = new AtomicCoreError(code as 'CPU_NO_AVX', 'x')
    expect(loadFailureReport({ provider: 'llamacpp', modelId: 'm', error })).toBeNull()
  })
})

describe('diffusionFailureReport', () => {
  it('reports an engine crash during a job', () => {
    const error = new AtomicCoreError('ENGINE_CRASHED', 'sd-server exited', 'fatal error: cudaMalloc failed')
    expect(diffusionFailureReport({ phase: 'job', error, family: 'flux', engine: 'cuda' })).toMatchObject({
      source: 'diffusion_job',
      level: 'error',
      fingerprint: ['diffusion-failure', 'ENGINE_CRASHED'],
      tags: { provider: 'diffusion', error_code: 'ENGINE_CRASHED', diffusion_family: 'flux', engine: 'cuda' },
      extra: { engine_errors: 'fatal error: cudaMalloc failed' },
    })
  })

  it('reports a load failure; OOM and a blank frame are warnings; a plain throw is INTERNAL', () => {
    expect(
      diffusionFailureReport({ phase: 'load', error: new AtomicCoreError('MODEL_LOAD_FAILED', 'x') })
    ).toMatchObject({
      source: 'diffusion_load',
      fingerprint: ['diffusion-load-failure', 'MODEL_LOAD_FAILED'],
    })
    expect(
      diffusionFailureReport({ phase: 'job', error: new AtomicCoreError('OUT_OF_MEMORY', 'x') })?.level
    ).toBe('warning')
    expect(
      diffusionFailureReport({ phase: 'job', error: new AtomicCoreError('INVALID_OUTPUT', 'x') })?.level
    ).toBe('warning')
    expect(diffusionFailureReport({ phase: 'job', error: new Error('x') })?.fingerprint).toEqual([
      'diffusion-failure',
      'INTERNAL',
    ])
  })

  it.each([['ENGINE_MISSING'], ['CANCELLED'], ['DISK_FULL'], ['INVALID_DIMENSIONS']])(
    'ignores %s',
    (code) => {
      const error = new AtomicCoreError(code as 'CANCELLED', 'x')
      expect(diffusionFailureReport({ phase: 'job', error })).toBeNull()
    }
  )
})

describe('inferenceFailureReport', () => {
  const base = { provider: 'llamacpp-upstream' as const, modelId: 'm-Q8_0', oom: false }

  it('reports a compute failure as a warning with the engine headline', () => {
    const report = inferenceFailureReport({
      ...base,
      status: 500,
      body: '{"error":{"code":500,"message":"Compute error.\\nmore"}}',
      compute: true,
      oom: true,
    })
    expect(report).toMatchObject({
      level: 'warning',
      type: 'InferenceFailure',
      message: 'Compute error.',
      fingerprint: ['inference-failure', 'llamacpp-upstream', 'oom'],
      tags: { http_status: 500, failure_kind: 'oom', quant: 'Q8_0' },
    })
  })

  it('reports another 5xx as an error', () => {
    expect(
      inferenceFailureReport({ ...base, status: 503, body: 'upstream down', compute: false })
    ).toMatchObject({
      level: 'error',
      message: 'upstream down',
      fingerprint: ['inference-failure', 'llamacpp-upstream', '503'],
    })
    expect(
      inferenceFailureReport({ ...base, status: 502, body: '{"error":"bad gateway"}', compute: false })
        ?.message
    ).toBe('bad gateway')
    expect(inferenceFailureReport({ ...base, status: 500, body: '', compute: false })?.message).toBe(
      'HTTP 500'
    )
    expect(
      inferenceFailureReport({ ...base, status: 500, body: '{"message":"m"}', compute: true })?.message
    ).toBe('m')
  })

  it('leaves a 4xx to the app', () => {
    expect(inferenceFailureReport({ ...base, status: 400, body: 'context', compute: false })).toBeNull()
  })
})
