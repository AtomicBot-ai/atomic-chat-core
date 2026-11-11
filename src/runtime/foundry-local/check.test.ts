import { describe, expect, it } from 'vitest'
import type { FoundryLocalAccelerator, FoundryLocalCheckVerdict } from '../../contracts/index.js'
import { foundryLocalVerdict, parseFoundryLocalCheckRequest } from './check.js'
import type { FoundryLocalCheckFacts } from './check.js'

const ep = (name: string, prepared: boolean): FoundryLocalAccelerator => ({
  name,
  execution_provider: null,
  device: 'gpu',
  prepared,
})
const WINDOWS_WITH_NPU: FoundryLocalCheckFacts = {
  platform: 'win32',
  arch: 'x64',
  installed: true,
  npu: true,
  accelerators: [ep('OpenVINOExecutionProvider', true), ep('CUDAExecutionProvider', false)],
}

describe('foundryLocalVerdict (task 6.5)', () => {
  it.each<
    [
      string,
      Partial<typeof WINDOWS_WITH_NPU> & { npu?: boolean | null },
      string,
      string,
      FoundryLocalCheckVerdict,
    ]
  >([
    ['an OpenVINO NPU variant on a prepared Core Ultra', {}, 'openvino', 'npu', 'ok'],
    ['a CPU variant, always', { accelerators: [] }, 'cpu', 'cpu', 'ok'],
    ['CUDA found but not prepared', {}, 'cuda', 'gpu', 'accelerator-not-prepared'],
    [
      'an NPU variant on Windows without an NPU, though Windows ML offers OpenVINO',
      { npu: false },
      'openvino',
      'npu',
      'accelerator-unavailable',
    ],
    ['an OpenVINO GPU variant on Windows without an NPU', { npu: false }, 'openvino', 'gpu', 'ok'],
    [
      'an NPU variant when the NPU question could not be answered: the probe decides',
      { npu: null },
      'openvino',
      'npu',
      'ok',
    ],
    ['QNN that the library does not offer here', {}, 'qnn', 'npu', 'accelerator-unavailable'],
    ['no Foundry Local build installed', { installed: false }, 'openvino', 'npu', 'engine-not-installed'],
    ['a QNN variant on macOS', { platform: 'darwin', arch: 'arm64' }, 'qnn', 'npu', 'platform-unsupported'],
    [
      'a WebGPU variant on Linux',
      { platform: 'linux', arch: 'x64' },
      'webgpu',
      'gpu',
      'platform-unsupported',
    ],
    [
      'CUDA on Linux ARM64 needs Foundry 2.4.0',
      { platform: 'linux', arch: 'arm64', runtimeVersion: '2.1.0' },
      'cuda',
      'gpu',
      'engine-update-required',
    ],
    [
      'CUDA on Linux ARM64 can use the prepared Foundry 2.4.0 provider',
      {
        platform: 'linux',
        arch: 'arm64',
        runtimeVersion: '2.4.0',
        accelerators: [ep('CUDAExecutionProvider', true)],
      },
      'cuda',
      'gpu',
      'ok',
    ],
    [
      'an accelerator this core does not know (TensorRT-RTX)',
      {},
      'nvtensorrtrtx',
      'gpu',
      'platform-unsupported',
    ],
  ])('%s', (_name, over, executionProvider, device, verdict) => {
    const result = foundryLocalVerdict(
      { ...WINDOWS_WITH_NPU, ...over },
      { execution_provider: executionProvider, device }
    )
    expect(result.verdict).toBe(verdict)
    expect(result.reason === null).toBe(verdict === 'ok')
  })

  it('names the accelerator the variant needs, none for the CPU', () => {
    expect(foundryLocalVerdict(WINDOWS_WITH_NPU, { execution_provider: 'cuda', device: 'gpu' })).toEqual({
      verdict: 'accelerator-not-prepared',
      reason: expect.stringContaining('CUDAExecutionProvider'),
      accelerator: 'CUDAExecutionProvider',
    })
    expect(foundryLocalVerdict(WINDOWS_WITH_NPU, { execution_provider: 'cpu', device: 'cpu' })).toEqual({
      verdict: 'ok',
      reason: null,
      accelerator: null,
    })
  })
})

describe('parseFoundryLocalCheckRequest', () => {
  it('takes the accelerator and the device, and nothing else', () => {
    expect(parseFoundryLocalCheckRequest({ execution_provider: 'openvino', device: 'npu' })).toEqual({
      execution_provider: 'openvino',
      device: 'npu',
    })
    for (const bad of [
      null,
      [],
      {},
      { execution_provider: 'openvino' },
      { execution_provider: 1, device: 'npu' },
      { execution_provider: 'cpu', device: 'cpu', extra: 1 },
    ])
      expect(() => parseFoundryLocalCheckRequest(bad), JSON.stringify(bad)).toThrow(
        expect.objectContaining({ code: 'INVALID_ARGUMENT' })
      )
  })
})

describe('Foundry minimum runtime version', () => {
  const cpu = { execution_provider: 'cpu', device: 'cpu', min_runtime_version: '2.4.0' }
  it.each([
    ['2.1.0', 'engine-update-required'],
    ['2.4.0', 'ok'],
    ['2.10.0', 'ok'],
    ['2.3.99', 'engine-update-required'],
  ] as const)('compares runtime %s numerically: %s', (runtimeVersion, verdict) => {
    const result = foundryLocalVerdict({ ...WINDOWS_WITH_NPU, runtimeVersion }, cpu)
    expect(result.verdict).toBe(verdict)
    if (verdict === 'engine-update-required') {
      expect(result.reason).toContain(runtimeVersion)
      expect(result.reason).toContain('2.4.0')
    }
  })
  it('keeps missing-engine precedence and treats zero as no extra minimum', () => {
    expect(foundryLocalVerdict({ ...WINDOWS_WITH_NPU, installed: false }, cpu).verdict).toBe(
      'engine-not-installed'
    )
    expect(
      foundryLocalVerdict(
        { ...WINDOWS_WITH_NPU, runtimeVersion: '2.1.0' },
        { ...cpu, min_runtime_version: '0.0.0' }
      ).verdict
    ).toBe('ok')
  })
  it('parses an optional valid minimum and rejects invalid direct requests', () => {
    expect(parseFoundryLocalCheckRequest(cpu)).toEqual(cpu)
    for (const value of [null, 2.4, '', '2.4', 'v2.4.0', '2.4.0-beta', ' 2.4.0 '])
      expect(() => parseFoundryLocalCheckRequest({ ...cpu, min_runtime_version: value })).toThrow(
        expect.objectContaining({ code: 'INVALID_ARGUMENT' })
      )
  })
})
