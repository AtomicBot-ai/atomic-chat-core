import { describe, expect, it } from 'vitest'
import {
  CUDA13_PDL_LOCATION_ONLY_STDERR,
  CUDA13_TURING_PTX_STDERR,
  CUDA_NO_KERNEL_IMAGE_STDERR,
  STATUS_DLL_INIT_FAILED,
  STATUS_DLL_NOT_FOUND,
  STATUS_ILLEGAL_INSTRUCTION,
  STATUS_INVALID_IMAGE_FORMAT,
} from '../../../test/helpers/llamacpp-load-failures.js'
import {
  ARGUMENT_REJECTED_MESSAGE,
  classifyExit,
  classifyProcessOutput,
  classifyStderr,
  CPU_INSTRUCTION_UNSUPPORTED_MESSAGE,
  CRASH_MESSAGE,
  ENGINE_BINARY_BROKEN_MESSAGE,
  formatExitCode,
  GENERIC_PROCESS_ERROR_MESSAGE,
  GPU_BACKEND_INCOMPATIBLE_MESSAGE,
  isCrashExit,
  signalNumber,
  windowsExitCause,
  WINDOWS_ILLEGAL_INSTRUCTION,
  WINDOWS_LOADER_FAILURES,
} from './errors.js'

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
  it('retains native exit facts without changing the public error body', () => {
    const error = classifyProcessOutput({ code: null, signal: 'SIGABRT' }, 'GGML_ASSERT(x)', '', 'linux')
    expect(error.diagnostic).toEqual({
      component: 'runtime',
      operation: 'load',
      stage: 'ready',
      exitCode: null,
      signal: 'SIGABRT',
      nativeFailure: 'assertion',
      reason: 'native_crash',
    })
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      code: 'LLAMA_CPP_PROCESS_ERROR',
      message: CRASH_MESSAGE,
      details: 'GGML_ASSERT(x)',
    })
    expect(
      classifyProcessOutput({ code: 1, signal: null }, '', 'out of memory', 'linux').diagnostic
    ).toMatchObject({ exitCode: 1, signal: null })
  })
  it('upgrades only the generic error on a crash', () => {
    expect(classifyExit({ code: null, signal: 11 }, '', 'linux').message).toBe(CRASH_MESSAGE)
    expect(classifyExit({ code: null, signal: 11 }, 'out of memory', 'linux').code).toBe('OUT_OF_MEMORY')
    expect(classifyExit({ code: 1, signal: null }, '', 'linux').message).toBe(GENERIC_PROCESS_ERROR_MESSAGE)
  })
  it('falls back to stdout and uses it as details only when stderr is blank', () => {
    const exit = { code: 1, signal: null }
    expect(classifyProcessOutput(exit, '', 'invalid magic', 'linux').code).toBe('MODEL_FILE_CORRUPT')
    expect(classifyProcessOutput(exit, ' \n', 'verbose', 'linux').details).toBe('verbose')
    expect(classifyProcessOutput(exit, 'x', 'verbose', 'linux').details).toBe('x')
    expect(classifyProcessOutput(exit, 'out of memory', 'invalid magic', 'linux').code).toBe('OUT_OF_MEMORY')
  })
  // `tensor_layout_mismatch_is_backend_incompatibility_not_corruption` (TurboQuant `error.rs`,
  // app commit ec1fd3ea7); core applies the correction to every provider.
  it('reads a tensor-count mismatch as an unsupported architecture on every provider', () => {
    const stdout = 'llama_model_load: done_getting_tensors: wrong number of tensors; expected 417, got 408\n'
    const exit = { code: 1, signal: null }
    expect(classifyProcessOutput(exit, '', stdout, 'linux', 'llamacpp').code).toBe('MODEL_ARCH_NOT_SUPPORTED')
    expect(classifyProcessOutput(exit, '', stdout, 'linux', 'llamacpp-upstream').code).toBe(
      'MODEL_ARCH_NOT_SUPPORTED'
    )
    expect(classifyProcessOutput(exit, '', stdout, 'linux').code).toBe('MODEL_ARCH_NOT_SUPPORTED')
    expect(classifyStderr(stdout, 'llamacpp').code).toBe('MODEL_ARCH_NOT_SUPPORTED')
    // The other corruption markers stay corruption on both.
    expect(classifyStderr('invalid magic', 'llamacpp').code).toBe('MODEL_FILE_CORRUPT')
  })
  it('keeps the crash message but still classifies stdout first', () => {
    const err = classifyProcessOutput({ code: null, signal: 6 }, '', 'unknown model architecture', 'darwin')
    expect(err.code).toBe('MODEL_ARCH_NOT_SUPPORTED')
  })
})

describe('a GPU build this card or driver cannot run', () => {
  it.each([
    ['the PTX toolchain error of CUDA 13.x on Turing', CUDA13_TURING_PTX_STDERR],
    ['its location lines alone', CUDA13_PDL_LOCATION_ONLY_STDERR],
    ['no kernel image for the architecture', CUDA_NO_KERNEL_IMAGE_STDERR],
  ])('reads %s as GPU_BACKEND_INCOMPATIBLE and says to update the driver', (_name, stderr) => {
    const err = classifyProcessOutput({ code: 1, signal: null }, stderr, '', 'win32')
    expect(err.code).toBe('GPU_BACKEND_INCOMPATIBLE')
    expect(err.message).toBe(GPU_BACKEND_INCOMPATIBLE_MESSAGE)
    expect(err.message).toMatch(/Update the NVIDIA graphics driver/)
    expect(err.details).toBe(stderr)
  })
  it('needs both halves of the location pair', () => {
    expect(classifyStderr('in function ggml_cuda_kernel_can_use_pdl at x').code).toBe(
      'LLAMA_CPP_PROCESS_ERROR'
    )
    expect(classifyStderr('cudaFuncGetAttributes(&attr, kernel)').code).toBe('LLAMA_CPP_PROCESS_ERROR')
  })
  it('ranks below out-of-memory and above every model rule and the generic error', () => {
    expect(classifyStderr(`${CUDA13_TURING_PTX_STDERR}cudaMalloc failed: out of memory\n`).code).toBe(
      'OUT_OF_MEMORY'
    )
    expect(classifyStderr(`unknown model architecture: x\n${CUDA_NO_KERNEL_IMAGE_STDERR}`).code).toBe(
      'GPU_BACKEND_INCOMPATIBLE'
    )
    expect(classifyExit({ code: 0xc000_0409, signal: null }, CUDA13_TURING_PTX_STDERR, 'win32').code).toBe(
      'GPU_BACKEND_INCOMPATIBLE'
    )
    expect(classifyProcessOutput({ code: 1, signal: null }, '', CUDA13_TURING_PTX_STDERR, 'win32').code).toBe(
      'GPU_BACKEND_INCOMPATIBLE'
    )
  })
})

describe('Windows exit statuses stderr did not explain', () => {
  it.each([
    [STATUS_DLL_NOT_FOUND, 'ENGINE_BINARY_BROKEN', ENGINE_BINARY_BROKEN_MESSAGE],
    [STATUS_DLL_NOT_FOUND | 0, 'ENGINE_BINARY_BROKEN', ENGINE_BINARY_BROKEN_MESSAGE],
    [STATUS_INVALID_IMAGE_FORMAT, 'ENGINE_BINARY_BROKEN', ENGINE_BINARY_BROKEN_MESSAGE],
    [STATUS_DLL_INIT_FAILED, 'ENGINE_BINARY_BROKEN', ENGINE_BINARY_BROKEN_MESSAGE],
    [0xc000_0138, 'ENGINE_BINARY_BROKEN', ENGINE_BINARY_BROKEN_MESSAGE],
    [0xc000_0139, 'ENGINE_BINARY_BROKEN', ENGINE_BINARY_BROKEN_MESSAGE],
    [STATUS_ILLEGAL_INSTRUCTION, 'CPU_INSTRUCTION_UNSUPPORTED', CPU_INSTRUCTION_UNSUPPORTED_MESSAGE],
    [STATUS_ILLEGAL_INSTRUCTION | 0, 'CPU_INSTRUCTION_UNSUPPORTED', CPU_INSTRUCTION_UNSUPPORTED_MESSAGE],
  ])('exit 0x%s with empty stderr → %s', (code, expected, message) => {
    const err = classifyProcessOutput({ code, signal: null }, '', '', 'win32')
    expect(err.code).toBe(expected)
    expect(err.message).toBe(message)
    expect(err.details).toBe('')
    expect(err.diagnostic).toMatchObject({ exitCode: code })
  })
  it('names the same set the image and audio engines read', () => {
    expect([...WINDOWS_LOADER_FAILURES.keys()].map((c) => formatExitCode(c, 'win32'))).toEqual([
      '0xC0000135',
      '0xC0000138',
      '0xC0000139',
      '0xC000007B',
      '0xC0000142',
    ])
    expect(WINDOWS_ILLEGAL_INSTRUCTION).toBe(STATUS_ILLEGAL_INSTRUCTION)
  })
  it('loses to a stderr or stdout rule and means nothing off Windows or without a code', () => {
    const exit = { code: STATUS_DLL_NOT_FOUND, signal: null }
    expect(classifyProcessOutput(exit, 'ggml: out of memory', '', 'win32').code).toBe('OUT_OF_MEMORY')
    expect(classifyProcessOutput(exit, '', 'gguf: invalid magic', 'win32').code).toBe('MODEL_FILE_CORRUPT')
    expect(classifyProcessOutput(exit, '', 'verbose', 'win32')).toMatchObject({
      code: 'ENGINE_BINARY_BROKEN',
      details: 'verbose',
    })
    expect(classifyProcessOutput(exit, '', '', 'linux').code).toBe('LLAMA_CPP_PROCESS_ERROR')
    expect(windowsExitCause(exit, 'darwin')).toBeUndefined()
    expect(windowsExitCause({ code: null, signal: 'SIGKILL' }, 'win32')).toBeUndefined()
    expect(windowsExitCause({ code: 1, signal: null }, 'win32')).toBeUndefined()
    // A crash status keeps the crash message, as before.
    expect(classifyExit({ code: 0xc000_0005, signal: null }, '', 'win32').message).toBe(CRASH_MESSAGE)
  })
  it('formatExitCode spells Windows statuses as hex and everything else as decimal', () => {
    expect(formatExitCode(-1073741515, 'win32')).toBe('0xC0000135')
    expect(formatExitCode(3221225781, 'win32')).toBe('0xC0000135')
    expect(formatExitCode(1, 'win32')).toBe('0x1')
    expect(formatExitCode(139, 'linux')).toBe('139')
    expect(formatExitCode(null, 'win32')).toBeUndefined()
  })
})
