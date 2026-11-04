import { describe, expect, it } from 'vitest'
import {
  CUDA13_TURING_PTX_STDERR,
  STATUS_DLL_NOT_FOUND,
} from '../../../test/helpers/llamacpp-load-failures.js'
import { AtomicCoreError, parseLoadDiag } from '../../contracts/index.js'
import type { ErrorCode } from '../../contracts/index.js'
import { classifyProcessOutput } from './errors.js'
import {
  attemptLoadDiag,
  backendFallbackTrigger,
  isWeightsLoadedLine,
  loadFailureStage,
  withFallbackDiag,
  withLoadFailureDiag,
} from './load-failure.js'

const facts = {
  platform: 'win32' as const,
  backend: 'win-cuda-13.3-x64',
  version: 'b12019',
  printed: true,
  stderrPrinted: true,
  weightsLoaded: false,
  ready: false,
}

describe('loadFailureStage', () => {
  const at = (over: Partial<Parameters<typeof loadFailureStage>[0]>) =>
    loadFailureStage({
      code: 'LLAMA_CPP_PROCESS_ERROR',
      printed: true,
      weightsLoaded: false,
      ready: false,
      ...over,
    })
  it('places a failure where the process stopped', () => {
    expect(at({ ready: true })).toBe('runtime')
    expect(at({ code: 'IO_ERROR', printed: false })).toBe('spawn')
    expect(at({ code: 'ENGINE_BINARY_BROKEN' })).toBe('spawn')
    expect(at({ printed: false })).toBe('spawn')
    expect(at({})).toBe('load')
    expect(at({ code: 'MODEL_LOAD_TIMED_OUT', printed: false })).toBe('load')
    expect(at({ weightsLoaded: true })).toBe('ready')
    expect(at({ code: 'MODEL_LOAD_TIMED_OUT', weightsLoaded: true })).toBe('ready')
  })
  it('recognises the line llama-server prints once the weights are in memory', () => {
    expect(isWeightsLoadedLine('main: model loaded')).toBe(true)
    expect(isWeightsLoadedLine('srv    load_model: loading model')).toBe(false)
  })
})

describe('the diag line of a failed attempt', () => {
  it('carries the Windows exit status as hex, the build and the stage, and keeps the error body', () => {
    const error = classifyProcessOutput({ code: 1, signal: null }, CUDA13_TURING_PTX_STDERR, '', 'win32')
    const diag = attemptLoadDiag(error, facts)
    expect(diag).toEqual({ exit_code: '0x1', stage: 'load', backend: 'win-cuda-13.3-x64', build: 'b12019' })
    const wrapped = withLoadFailureDiag(error, diag, 'b12019/win-cuda-13.3-x64') as AtomicCoreError
    expect(wrapped).toBeInstanceOf(AtomicCoreError)
    expect(wrapped.code).toBe('GPU_BACKEND_INCOMPATIBLE')
    expect(wrapped.message).toBe(error.message)
    expect(wrapped.details?.startsWith(CUDA13_TURING_PTX_STDERR.trimEnd())).toBe(true)
    expect(wrapped.details?.split('\n').at(-1)).toBe(
      'atomic-core-diag {"exit_code":"0x1","stage":"load","backend":"win-cuda-13.3-x64","build":"b12019"}'
    )
    expect(wrapped.diagnostic).toMatchObject({ exitCode: 1, engineVersion: 'b12019/win-cuda-13.3-x64' })
    expect(wrapped.stack).toBe(error.stack)
  })

  it('says a silent loader failure stopped at spawn with an empty stderr; a signal is kept on Unix', () => {
    const broken = classifyProcessOutput({ code: STATUS_DLL_NOT_FOUND, signal: null }, '', '', 'win32')
    expect(
      attemptLoadDiag(broken, { ...facts, printed: false, stderrPrinted: false, version: 'cli' })
    ).toEqual({ exit_code: '0xC0000135', stage: 'spawn', backend: 'win-cuda-13.3-x64', empty_stderr: true })
    const crashed = classifyProcessOutput({ code: null, signal: 'SIGSEGV' }, 'x', '', 'linux')
    expect(attemptLoadDiag(crashed, { ...facts, platform: 'linux' })).toMatchObject({ signal: 'SIGSEGV' })
    const timedOut = new AtomicCoreError('MODEL_LOAD_TIMED_OUT', 'Timeout: 1s', 'Timeout: 1s\n\nStderr:\n')
    expect(attemptLoadDiag(timedOut, { ...facts, version: '' })).toEqual({
      stage: 'load',
      backend: 'win-cuda-13.3-x64',
    })
  })

  it('leaves cancels, stops and foreign errors alone, and gives a bare error a diagnostic', () => {
    const cancelled = new AtomicCoreError('MODEL_LOAD_CANCELLED', 'cancelled')
    expect(withLoadFailureDiag(cancelled, { stage: 'load' })).toBe(cancelled)
    const foreign = new Error('disk is read-only')
    expect(withLoadFailureDiag(foreign, { stage: 'runtime' })).toBe(foreign)
    const bare = new AtomicCoreError('IO_ERROR', 'An input/output error occurred.', 'spawn ENOENT', {
      cause: foreign,
    })
    const wrapped = withLoadFailureDiag(bare, { stage: 'spawn' }, 'b1/win-cpu-x64') as AtomicCoreError
    expect(wrapped.diagnostic).toEqual({
      component: 'runtime',
      operation: 'load',
      engineVersion: 'b1/win-cpu-x64',
    })
    expect(wrapped.cause).toBe(foreign)
    expect(wrapped.details).toBe('spawn ENOENT\natomic-core-diag {"stage":"spawn"}')
    expect((withLoadFailureDiag(bare, { stage: 'spawn' }) as AtomicCoreError).diagnostic).toBeUndefined()
  })
})

describe('backendFallbackTrigger', () => {
  const withDiag = (code: ErrorCode, diag: object | undefined) =>
    new AtomicCoreError(code, 'm', diag ? `x\natomic-core-diag ${JSON.stringify(diag)}` : 'x')

  it('retries a GPU build the card or driver refused, on any build id', () => {
    expect(backendFallbackTrigger(withDiag('GPU_BACKEND_INCOMPATIBLE', undefined), 'odd')).toBe(
      'GPU_BACKEND_INCOMPATIBLE'
    )
  })
  it('retries a GPU build Windows could not start, or that died before printing a line', () => {
    expect(backendFallbackTrigger(withDiag('ENGINE_BINARY_BROKEN', undefined), 'win-vulkan-x64')).toBe(
      'ENGINE_BINARY_BROKEN'
    )
    const silent = { exit_code: '0xC0000005', empty_stderr: true }
    expect(backendFallbackTrigger(withDiag('LLAMA_CPP_PROCESS_ERROR', silent), 'win-cuda-12.4-x64')).toBe(
      'EMPTY_STDERR_CRASH'
    )
    expect(
      backendFallbackTrigger(
        withDiag('CPU_INSTRUCTION_UNSUPPORTED', { ...silent, exit_code: '0xC000001D' }),
        'win-cuda-13.3-x64'
      )
    ).toBe('EMPTY_STDERR_CRASH')
    expect(
      backendFallbackTrigger(
        withDiag('LLAMA_CPP_PROCESS_ERROR', { signal: 'SIGSEGV', empty_stderr: true }),
        'linux-vulkan-x64'
      )
    ).toBe('EMPTY_STDERR_CRASH')
  })
  it('does not retry a CPU build, a model failure, a clean or noisy exit, or a foreign error', () => {
    expect(backendFallbackTrigger(withDiag('ENGINE_BINARY_BROKEN', undefined), 'win-cpu-x64')).toBeUndefined()
    expect(
      backendFallbackTrigger(withDiag('OUT_OF_MEMORY', { empty_stderr: true }), 'win-cuda-13.3-x64')
    ).toBeUndefined()
    expect(
      backendFallbackTrigger(withDiag('LLAMA_CPP_PROCESS_ERROR', { exit_code: '1' }), 'win-cuda-13.3-x64')
    ).toBeUndefined()
    for (const exit_code of ['0', '0x0'])
      expect(
        backendFallbackTrigger(
          withDiag('LLAMA_CPP_PROCESS_ERROR', { exit_code, empty_stderr: true }),
          'win-vulkan-x64'
        )
      ).toBeUndefined()
    expect(
      backendFallbackTrigger(withDiag('LLAMA_CPP_PROCESS_ERROR', undefined), 'win-vulkan-x64')
    ).toBeUndefined()
    expect(backendFallbackTrigger(new Error('x'), 'win-cuda-13.3-x64')).toBeUndefined()
  })
})

describe('withFallbackDiag', () => {
  it('adds the fallback to the attempt diag of the error the load ends with', () => {
    const error = new AtomicCoreError(
      'OUT_OF_MEMORY',
      'Out of memory.',
      'oom\natomic-core-diag {"exit_code":"0x1","stage":"load","backend":"win-cuda-12.4-x64"}'
    )
    const final = withFallbackDiag(error, { from: 'win-cuda-13.3-x64', to: 'win-cuda-12.4-x64', ok: false })
    expect(parseLoadDiag((final as AtomicCoreError).details)).toEqual({
      exit_code: '0x1',
      stage: 'load',
      backend: 'win-cuda-12.4-x64',
      fallback_from: 'win-cuda-13.3-x64',
      fallback_to: 'win-cuda-12.4-x64',
      fallback_ok: false,
    })
    expect((final as AtomicCoreError).details?.split('\n')).toHaveLength(2)
    const stopped = new AtomicCoreError('CORE_NOT_RUNNING', 'stopping')
    expect(withFallbackDiag(stopped, { from: 'a', to: 'b', ok: false })).toBe(stopped)
    expect(
      parseLoadDiag(
        (
          withFallbackDiag(new AtomicCoreError('IO_ERROR', 'io'), {
            from: 'a',
            to: 'b',
            ok: false,
          }) as AtomicCoreError
        ).details
      )
    ).toEqual({ fallback_from: 'a', fallback_to: 'b', fallback_ok: false })
  })
})
