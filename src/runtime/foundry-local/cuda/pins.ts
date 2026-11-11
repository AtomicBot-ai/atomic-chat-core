import { LINUX_ARM64_CUDA, LINUX_X64_CUDA } from './linux-pins.js'

export interface CudaArchive {
  url: string
  size: number
  sha256: string
  files: readonly { entry: string; name: string; size: number }[]
}

function windowsArchive(
  component: string,
  version: string,
  size: number,
  sha256: string,
  bin: string,
  dlls: Record<string, number>,
  noticeSize: number,
  arch = 'x86_64'
): CudaArchive {
  const stem = `${component}-windows-${arch}-${version}-archive`
  const product = component === 'cudnn' ? 'cudnn' : 'cuda'
  return {
    url: `https://developer.download.nvidia.com/compute/${product}/redist/${component}/windows-${arch}/${stem}.zip`,
    size,
    sha256,
    files: [
      ...Object.entries(dlls).map(([name, size]) => ({ entry: `${stem}/${bin}/${name}`, name, size })),
      { entry: `${stem}/LICENSE`, name: `${component}.LICENSE`, size: noticeSize },
    ],
  }
}

// NVIDIA redistrib_12.8.1.json and cuDNN redistrib_9.20.0.json (CUDA 12 variant).
export const WINDOWS_X64_CUDA: readonly CudaArchive[] = [
  windowsArchive(
    'cuda_cudart',
    '12.8.90',
    3037735,
    '4a39058fd8519444a81cfc7ae055d136f48d1a31ffa41ae255b35b2edd61e13b',
    'bin',
    { 'cudart64_12.dll': 573952 },
    63021
  ),
  windowsArchive(
    'libcublas',
    '12.8.4.1',
    563660944,
    '57a470112cec7e112c95253dde8b3c7184d795dbd92b0bde77a4cb7f8c94c8aa',
    'bin',
    { 'cublas64_12.dll': 113716224, 'cublasLt64_12.dll': 674667520 },
    63021
  ),
  windowsArchive(
    'cudnn',
    '9.20.0.48_cuda12',
    634960681,
    '003a5d022899268f7deef0c3530f1587a3195a93905a16fd0e3c9da0c46b88ab',
    'bin/x64',
    {
      'cudnn64_9.dll': 264304,
      'cudnn_adv64_9.dll': 269016688,
      'cudnn_cnn64_9.dll': 2984560,
      'cudnn_engines_precompiled64_9.dll': 480614000,
      'cudnn_engines_runtime_compiled64_9.dll': 27769456,
      'cudnn_graph64_9.dll': 2535536,
      'cudnn_heuristic64_9.dll': 58882672,
      'cudnn_ops64_9.dll': 105600624,
    },
    29574
  ),
]

// NVIDIA CUDA 13.4 Update 2 and the corresponding cuDNN 9.25 redistribution ZIPs.
const WINDOWS_ARM64_CUDA: readonly CudaArchive[] = [
  windowsArchive(
    'cuda_cudart',
    '13.4.92',
    2772086,
    'd3cec2717ba3c2c714c5869a5374365d087c698d87c0ddd3bd41715447112891',
    'bin/arm64',
    {
      'cudart64_13.dll': 606832,
    },
    69791,
    'arm64'
  ),
  windowsArchive(
    'libcublas',
    '13.8.0.4',
    153929951,
    'ec79698528f64361a370d1b0254a927e369b57525831fadcb2cdb7732d8ab621',
    'bin/arm64',
    {
      'cublas64_13.dll': 24142448,
      'cublasLt64_13.dll': 194595440,
    },
    69791,
    'arm64'
  ),
  windowsArchive(
    'cudnn',
    '9.25.1.1_cuda13.4',
    433715143,
    'be292b95ad6511aa01ada7094d16eee78acd69369d996586366d82ffe53b16c7',
    'bin/arm64',
    {
      'cudnn64_9.dll': 271472,
      'cudnn_adv64_9.dll': 23012976,
      'cudnn_cnn64_9.dll': 627824,
      'cudnn_engines_precompiled64_9.dll': 61971568,
      'cudnn_engines_runtime_compiled64_9.dll': 32155760,
      'cudnn_engines_tensor_ir64_9.dll': 150128,
      'cudnn_ext64_9.dll': 137840,
      'cudnn_graph64_9.dll': 107633776,
      'cudnn_heuristic64_9.dll': 58245232,
      'cudnn_ops64_9.dll': 13165168,
    },
    29574,
    'arm64'
  ),
]

export const CUDA_ARCHIVES: Readonly<Record<string, readonly CudaArchive[] | undefined>> = {
  'win-x64': WINDOWS_X64_CUDA,
  'win-arm64': WINDOWS_ARM64_CUDA,
  'linux-x64': LINUX_X64_CUDA,
  'linux-arm64': LINUX_ARM64_CUDA,
}
