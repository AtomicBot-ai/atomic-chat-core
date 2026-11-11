import type { CudaArchive } from './pins.js'

// NVIDIA publishes the ELF runtimes as ZIP-format wheels with real SONAME files. Core
// extracts those files directly, so installing them needs neither Python nor an xz tool.
function wheel(
  component: string,
  url: string,
  size: number,
  sha256: string,
  bin: string,
  libraries: Record<string, number>,
  license: string,
  noticeSize: number
): CudaArchive {
  return {
    url,
    size,
    sha256,
    files: [
      ...Object.entries(libraries).map(([name, size]) => ({ entry: `${bin}/${name}`, name, size })),
      { entry: license, name: `${component}.LICENSE`, size: noticeSize },
    ],
  }
}

export const LINUX_X64_CUDA: readonly CudaArchive[] = [
  wheel(
    'cuda-runtime',
    'https://files.pythonhosted.org/packages/bc/46/a92db19b8309581092a3add7e6fceb4c301a3fd233969856a8cbf042cd3c/nvidia_cuda_runtime_cu12-12.9.79-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl',
    3493179,
    '25bba2dfb01d48a9b59ca474a1ac43c6ebf7011f1b0b8cc44f54eb6ac48a96c3',
    'nvidia/cuda_runtime/lib',
    {
      'libcudart.so.12': 741088,
    },
    'nvidia_cuda_runtime_cu12-12.9.79.dist-info/licenses/License.txt',
    59262
  ),
  wheel(
    'cublas',
    'https://files.pythonhosted.org/packages/77/3c/aa88abe01f3be3d1f8f787d1d33dc83e76fec05945f9a28fbb41cfb99cd5/nvidia_cublas_cu12-12.9.1.4-py3-none-manylinux_2_27_x86_64.whl',
    581242350,
    '453611eb21a7c1f2c2156ed9f3a45b691deda0440ec550860290dc901af5b4c2',
    'nvidia/cublas/lib',
    {
      'libcublas.so.12': 105140976,
      'libcublasLt.so.12': 749205904,
    },
    'nvidia_cublas_cu12-12.9.1.4.dist-info/licenses/License.txt',
    59262
  ),
  wheel(
    'cufft',
    'https://files.pythonhosted.org/packages/95/f4/61e6996dd20481ee834f57a8e9dca28b1869366a135e0d42e2aa8493bdd4/nvidia_cufft_cu12-11.4.1.4-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl',
    200877592,
    'c67884f2a7d276b4b80eb56a79322a95df592ae5e765cf1243693365ccab4e28',
    'nvidia/cufft/lib',
    {
      'libcufft.so.11': 291507928,
    },
    'nvidia_cufft_cu12-11.4.1.4.dist-info/licenses/License.txt',
    59262
  ),
  wheel(
    'curand',
    'https://files.pythonhosted.org/packages/31/44/193a0e171750ca9f8320626e8a1f2381e4077a65e69e2fb9708bd479e34a/nvidia_curand_cu12-10.3.10.19-py3-none-manylinux_2_27_x86_64.whl',
    68295626,
    '49b274db4780d421bd2ccd362e1415c13887c53c214f0d4b761752b8f9f6aa1e',
    'nvidia/curand/lib',
    {
      'libcurand.so.10': 166965432,
    },
    'nvidia_curand_cu12-10.3.10.19.dist-info/License.txt',
    59262
  ),
  wheel(
    'cuda-nvrtc',
    'https://files.pythonhosted.org/packages/b8/85/e4af82cc9202023862090bfca4ea827d533329e925c758f0cde964cb54b7/nvidia_cuda_nvrtc_cu12-12.9.86-py3-none-manylinux2010_x86_64.manylinux_2_12_x86_64.whl',
    89568129,
    '210cf05005a447e29214e9ce50851e83fc5f4358df8b453155d5e1918094dcb4',
    'nvidia/cuda_nvrtc/lib',
    {
      'libnvrtc-builtins.so.12.9': 7202760,
      'libnvrtc.so.12': 106244480,
    },
    'nvidia_cuda_nvrtc_cu12-12.9.86.dist-info/licenses/License.txt',
    59262
  ),
  wheel(
    'cudnn',
    'https://files.pythonhosted.org/packages/3b/52/94aecda69df65ba1079a8b7dbe84632af5614dc0ed2c733185f6431874e3/nvidia_cudnn_cu12-9.20.0.48-py3-none-manylinux_2_27_x86_64.whl',
    657910570,
    '7d7479e1321c7a039b33827f0247791ee1be091759032c1f66a287c4a643396a',
    'nvidia/cudnn/lib',
    {
      'libcudnn.so.9': 129240,
      'libcudnn_adv.so.9': 272749720,
      'libcudnn_cnn.so.9': 4203784,
      'libcudnn_engines_precompiled.so.9': 515924288,
      'libcudnn_engines_runtime_compiled.so.9': 31483576,
      'libcudnn_graph.so.9': 4460064,
      'libcudnn_heuristic.so.9': 60822016,
      'libcudnn_ops.so.9': 106964632,
    },
    'nvidia_cudnn_cu12-9.20.0.48.dist-info/licenses/License.txt',
    18174
  ),
]

export const LINUX_ARM64_CUDA: readonly CudaArchive[] = [
  wheel(
    'cuda-runtime',
    'https://files.pythonhosted.org/packages/51/3b/2c6e9d88efa7b3585572760bca5e7da83fa9e06098a9386c7b29c81c46b2/nvidia_cuda_runtime-13.4.92-py3-none-manylinux2014_aarch64.manylinux_2_17_aarch64.whl',
    2509438,
    'bef071788589550ab02846fcbc732a2b88c2b16f2cd8a0f45d98e68e8c5fb0c8',
    'nvidia/cu13/lib',
    {
      'libcudart.so.13': 793872,
    },
    'nvidia_cuda_runtime-13.4.92.dist-info/licenses/License.txt',
    59262
  ),
  wheel(
    'cublas',
    'https://files.pythonhosted.org/packages/c9/9e/0c73b14c14cd32e8b3a028133371f4bf1d9d14b811c515c5fd1201a3c38d/nvidia_cublas-13.8.0.4-py3-none-manylinux_2_27_aarch64.whl',
    552729449,
    'e22b25be18f8b7d267dbbe2a8ec78e2c69c05762536d299dd0afa2c847115740',
    'nvidia/cu13/lib',
    {
      'libcublas.so.13': 71959256,
      'libcublasLt.so.13': 648206104,
    },
    'nvidia_cublas-13.8.0.4.dist-info/licenses/License.txt',
    59262
  ),
  wheel(
    'cufft',
    'https://files.pythonhosted.org/packages/41/f1/bb8cc4e1ffee345a51fe4cf656352bc705274431dcbd6c23ed9f00585ec7/nvidia_cufft-12.4.0.43-py3-none-manylinux2014_aarch64.manylinux_2_17_aarch64.whl',
    161750525,
    '3938644a5b594e06d396e02d6e52bdd84589b3c1f3a8a127a2704211c2abc441',
    'nvidia/cu13/lib',
    {
      'libcufft.so.12': 231611600,
    },
    'nvidia_cufft-12.4.0.43.dist-info/licenses/License.txt',
    59262
  ),
  wheel(
    'curand',
    'https://files.pythonhosted.org/packages/e8/9d/42faff77e90e5498eecb9b099894d5deea744b3d6b35e700dafd0381e07a/nvidia_curand-10.4.4.72-py3-none-manylinux_2_27_aarch64.whl',
    63771251,
    '53bef256d4362eb3d70c9c048a8d31bcf003f9dcade17720c73d3a494a7dcaa3',
    'nvidia/cu13/lib',
    {
      'libcurand.so.10': 136236248,
    },
    'nvidia_curand-10.4.4.72.dist-info/licenses/License.txt',
    59262
  ),
  wheel(
    'cuda-nvrtc',
    'https://files.pythonhosted.org/packages/4f/73/cf76dc0083d68bd1e29309bc51fc95ada28d4b64d341e945eb3f8ec8edec/nvidia_cuda_nvrtc-13.4.92-py3-none-manylinux2014_aarch64.manylinux_2_17_aarch64.whl',
    50927348,
    '24b9f5eccc6a5a19779038cf468aecb7cecfa8716269beaef5640bd989d21c28',
    'nvidia/cu13/lib',
    {
      'libnvrtc-builtins.so.13.4': 7108392,
      'libnvrtc.so.13': 115809136,
    },
    'nvidia_cuda_nvrtc-13.4.92.dist-info/licenses/License.txt',
    59262
  ),
  wheel(
    'nvjitlink',
    'https://files.pythonhosted.org/packages/1f/a8/1cbd4014898af8b419e69b0d7dbc63da2121ee92d92b47d59f4fe9075349/nvidia_nvjitlink-13.4.92-py3-none-manylinux2014_aarch64.manylinux_2_17_aarch64.whl',
    40420120,
    '25f74fad0d654271c921ac4dca614bd6258bc21791242fc7b2289dad7ae9c099',
    'nvidia/cu13/lib',
    {
      'libnvJitLink.so.13': 93911560,
    },
    'nvidia_nvjitlink-13.4.92.dist-info/licenses/License.txt',
    59262
  ),
  wheel(
    'cudnn',
    'https://files.pythonhosted.org/packages/fb/de/5038a69d0f35f75b28d00d7de9ea219969096b11812bbb3097604059b9a6/nvidia_cudnn_cu13-9.25.1.1-py3-none-manylinux_2_27_aarch64.whl',
    601067473,
    '6ed974d46b1b5fd123c0d9ff031c857142aa94257c6df41c40f6b5fd11a01d50',
    'nvidia/cudnn/lib',
    {
      'libcudnn.so.9': 6329600,
      'libcudnn_adv.so.9': 140627624,
      'libcudnn_cnn.so.9': 2501816,
      'libcudnn_engines_precompiled.so.9': 316686752,
      'libcudnn_engines_runtime_compiled.so.9': 39867664,
      'libcudnn_engines_tensor_ir.so.9': 211822608,
      'libcudnn_ext.so.9': 2039600,
      'libcudnn_graph.so.9': 128140800,
      'libcudnn_heuristic.so.9': 65015144,
      'libcudnn_ops.so.9': 54537056,
    },
    'nvidia_cudnn_cu13-9.25.1.1.dist-info/licenses/License.txt',
    18174
  ),
]
