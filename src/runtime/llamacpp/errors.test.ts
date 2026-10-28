import { describe, expect, it } from 'vitest'
import {
  ARGUMENT_REJECTED_MESSAGE,
  classifyExit,
  classifyProcessOutput,
  classifyStderr,
  CRASH_MESSAGE,
  GENERIC_PROCESS_ERROR_MESSAGE,
  isCrashExit,
  signalNumber,
  TENSOR_SPLIT_FAILED_MESSAGE,
} from './errors.js'

// What a Windows user with two CUDA GPUs and `-sm tensor` got from the embedding model (ATO-556).
const META_ABORT =
  'W init: embeddings required but some input tokens were not marked as outputs -> overriding\n' +
  'D:/a/llama.cpp/llama.cpp/ggml/src/ggml-backend-meta.cpp:610: unsupported mul_mat split states: ' +
  'node=node_30 src0=blk.0.attn_output.weight axis=0 src1=Meta(CUDA0,CUDA1)#kqv_out-0#0 axis=10\n'

describe('classifyStderr', () => {
  it.each([
    ['dyld: Symbol not found: _x', 'OS_VERSION_UNSUPPORTED'],
    ['ggml: out of memory', 'OUT_OF_MEMORY'],
    ['unknown model architecture: q', 'MODEL_ARCH_NOT_SUPPORTED'],
    ['clip: unknown projector type: a', 'MULTIMODAL_PROJECTOR_LOAD_FAILED'],
    ['gguf: invalid magic', 'MODEL_FILE_CORRUPT'],
    ['nothing useful', 'LLAMA_CPP_PROCESS_ERROR'],
    ['', 'LLAMA_CPP_PROCESS_ERROR'],
  ])('%j → %s', (stderr, code) => {
    const err = classifyStderr(stderr)
    expect(err.code).toBe(code)
    expect(err.details).toBe(stderr)
  })

  // What b11642 prints for `--atomic-probe-unknown-flag` and for `--flash-attn bogus`
  // (test/live/llamacpp-contract.test.ts); TurboQuant and Prism share the parser.
  it.each([
    'error: invalid argument: --no-mmap',
    'error while handling argument "--flash-attn": error: unknown value for --flash-attn: \'bogus\'\n\nusage:\n…',
  ])('says the build refused its arguments: %j', (stderr) => {
    const err = classifyProcessOutput({ code: 1, signal: null }, `${stderr}\n`, '', 'linux')
    expect(err.code).toBe('LLAMA_CPP_PROCESS_ERROR')
    expect(err.message).toBe(ARGUMENT_REJECTED_MESSAGE)
    expect(err.details).toBe(`${stderr}\n`)
  })

  it('names the tensor split when the meta backend aborts', () => {
    const err = classifyStderr(META_ABORT)
    expect(err.code).toBe('LLAMA_CPP_PROCESS_ERROR')
    expect(err.message).toBe(TENSOR_SPLIT_FAILED_MESSAGE)
    expect(err.details).toBe(META_ABORT)
    // An out-of-memory under a tensor split is still out of memory.
    expect(classifyStderr(`${META_ABORT}cudaMalloc failed: out of memory`).code).toBe('OUT_OF_MEMORY')
  })

  it('applies the cascade in order (OOM before arch, dyld before OOM)', () => {
    expect(classifyStderr('unknown model architecture\nfailed to allocate').code).toBe('OUT_OF_MEMORY')
    expect(classifyStderr('out of memory\ndyld symbol not found').code).toBe('OS_VERSION_UNSUPPORTED')
  })
})

describe('isCrashExit', () => {
  it('recognises SIGSEGV / SIGABRT by number and by Node name on unix', () => {
    expect(isCrashExit({ code: null, signal: 11 }, 'linux')).toBe(true)
    expect(isCrashExit({ code: null, signal: 'SIGABRT' }, 'darwin')).toBe(true)
    expect(isCrashExit({ code: null, signal: 'SIGKILL' }, 'darwin')).toBe(false)
    expect(isCrashExit({ code: 139, signal: null }, 'linux')).toBe(false)
  })
  it('recognises the three Windows NTSTATUS crash codes, signed or unsigned', () => {
    expect(isCrashExit({ code: 0xc0000005, signal: null }, 'win32')).toBe(true)
    expect(isCrashExit({ code: 0xc0000005 | 0, signal: null }, 'win32')).toBe(true)
    expect(isCrashExit({ code: 0xc00000fd, signal: null }, 'win32')).toBe(true)
    expect(isCrashExit({ code: 0xc0000409, signal: null }, 'win32')).toBe(true)
    expect(isCrashExit({ code: 1, signal: null }, 'win32')).toBe(false)
    expect(isCrashExit({ code: null, signal: 11 }, 'win32')).toBe(false)
  })
  it('signalNumber maps names and passes numbers through', () => {
    expect(signalNumber('SIGSEGV')).toBe(11)
    expect(signalNumber(6)).toBe(6)
    expect(signalNumber('SIGWHAT')).toBeNull()
    expect(signalNumber(null)).toBeNull()
  })
})

describe('classifyExit / classifyProcessOutput', () => {
  it('upgrades only the generic error on a crash', () => {
    expect(classifyExit({ code: null, signal: 11 }, '', 'linux').message).toBe(CRASH_MESSAGE)
    expect(classifyExit({ code: null, signal: 11 }, 'out of memory', 'linux').code).toBe('OUT_OF_MEMORY')
    expect(classifyExit({ code: 1, signal: null }, '', 'linux').message).toBe(GENERIC_PROCESS_ERROR_MESSAGE)
  })
  it('keeps the tensor-split message when GGML_ABORT ends the process', () => {
    expect(classifyExit({ code: null, signal: 'SIGABRT' }, META_ABORT, 'linux').message).toBe(
      TENSOR_SPLIT_FAILED_MESSAGE
    )
    // MSVC's abort() exits with 3; an NTSTATUS crash code must not override it either.
    expect(classifyProcessOutput({ code: 3, signal: null }, META_ABORT, '', 'win32').message).toBe(
      TENSOR_SPLIT_FAILED_MESSAGE
    )
    expect(classifyExit({ code: 0xc0000409, signal: null }, META_ABORT, 'win32').message).toBe(
      TENSOR_SPLIT_FAILED_MESSAGE
    )
  })
  it('falls back to stdout and uses it as details only when stderr is blank', () => {
    const exit = { code: 1, signal: null }
    expect(classifyProcessOutput(exit, '', 'invalid magic', 'linux').code).toBe('MODEL_FILE_CORRUPT')
    expect(classifyProcessOutput(exit, ' \n', 'verbose', 'linux').details).toBe('verbose')
    expect(classifyProcessOutput(exit, 'x', 'verbose', 'linux').details).toBe('x')
    expect(classifyProcessOutput(exit, 'out of memory', 'invalid magic', 'linux').code).toBe('OUT_OF_MEMORY')
  })
  // `tensor_layout_mismatch_is_backend_incompatibility_not_corruption` (TurboQuant `error.rs`,
  // app commit ec1fd3ea7); the upstream plugin keeps it as corruption.
  it('reads a tensor-count mismatch as an unsupported architecture only for TurboQuant', () => {
    const stdout = 'llama_model_load: done_getting_tensors: wrong number of tensors; expected 417, got 408\n'
    const exit = { code: 1, signal: null }
    expect(classifyProcessOutput(exit, '', stdout, 'linux', 'llamacpp').code).toBe('MODEL_ARCH_NOT_SUPPORTED')
    expect(classifyProcessOutput(exit, '', stdout, 'linux', 'llamacpp-upstream').code).toBe(
      'MODEL_FILE_CORRUPT'
    )
    expect(classifyProcessOutput(exit, '', stdout, 'linux').code).toBe('MODEL_FILE_CORRUPT')
    expect(classifyStderr(stdout, 'llamacpp').code).toBe('MODEL_ARCH_NOT_SUPPORTED')
    // The other corruption markers stay corruption on both.
    expect(classifyStderr('invalid magic', 'llamacpp').code).toBe('MODEL_FILE_CORRUPT')
  })
  it('keeps the crash message but still classifies stdout first', () => {
    const err = classifyProcessOutput({ code: null, signal: 6 }, '', 'unknown model architecture', 'darwin')
    expect(err.code).toBe('MODEL_ARCH_NOT_SUPPORTED')
  })
})
