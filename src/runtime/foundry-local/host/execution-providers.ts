/**
 * The three spellings of each accelerator (spike findings 6 and 14): conf and `model.yml` say `webgpu`,
 * the library's EP registration and `Manager_GetDiscoverableEps` say `WebGpuExecutionProvider` (ONNX
 * Runtime's name), and `RegisterModel` metadata wants `WebGPUExecutionProvider` (the catalog's name) —
 * `Load` refuses the ORT spelling with "unknown execution provider for local model".
 */

import type { FoundryLocalExecutionProvider } from '../../../contracts/index.js'

interface ExecutionProviderNames {
  short: FoundryLocalExecutionProvider
  /** What the variant runs on; OpenVINO serves Intel GPUs and NPUs alike (finding: offered without an NPU). */
  device: 'cpu' | 'gpu' | 'npu' | 'gpu/npu'
  /** `Manager_DownloadAndRegisterEps` / discoverable name; `null` for the CPU, which is always there. */
  register: string | null
  /** `execution_provider` in `RegisterModel` metadata. */
  metadata: string
}

export const EXECUTION_PROVIDERS: readonly ExecutionProviderNames[] = [
  { short: 'cpu', device: 'cpu', register: null, metadata: 'CPUExecutionProvider' },
  { short: 'cuda', device: 'gpu', register: 'CUDAExecutionProvider', metadata: 'CUDAExecutionProvider' },
  {
    short: 'webgpu',
    device: 'gpu',
    register: 'WebGpuExecutionProvider',
    metadata: 'WebGPUExecutionProvider',
  },
  {
    short: 'openvino',
    device: 'gpu/npu',
    register: 'OpenVINOExecutionProvider',
    metadata: 'OpenVINOExecutionProvider',
  },
  { short: 'qnn', device: 'npu', register: 'QNNExecutionProvider', metadata: 'QNNExecutionProvider' },
  {
    short: 'vitisai',
    device: 'npu',
    register: 'VitisAIExecutionProvider',
    metadata: 'VitisAIExecutionProvider',
  },
]

export function executionProvider(short: FoundryLocalExecutionProvider): ExecutionProviderNames {
  return EXECUTION_PROVIDERS.find((ep) => ep.short === short) as ExecutionProviderNames
}

/**
 * What the probe says about one discoverable accelerator. One this core does not run variants on
 * (`NvTensorRTRTXExecutionProvider`, design non-goal) keeps its name with `execution_provider: null`.
 */
export function describeDiscoverable(name: string): {
  execution_provider: FoundryLocalExecutionProvider | null
  device: string
} {
  const known = EXECUTION_PROVIDERS.find((ep) => ep.register === name)
  if (known) return { execution_provider: known.short, device: known.device }
  return { execution_provider: null, device: /TensorRT|Cuda|Gpu|DML/i.test(name) ? 'gpu' : 'unknown' }
}
