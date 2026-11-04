/**
 * What llama-server printed when a load failed on a user's Windows machine, after production
 * telemetry (`model_load.stderr_tail`). The CUDA error lines are verbatim, with the ggml-org CI's
 * source paths; telemetry reports their line numbers as `N`, so the numbers here and the startup
 * lines before the error are filled in.
 */

/**
 * A CUDA 13.x build on a Turing card (GTX 16xx / RTX 20xx, compute capability 7.5) with a driver
 * before R616: the PTX the build carries for 7.5 is from a toolchain the driver refuses.
 */
export const CUDA13_TURING_PTX_STDERR = [
  'ggml_cuda_init: found 1 CUDA devices:',
  '  Device 0: NVIDIA GeForce GTX 1660 SUPER, compute capability 7.5, VMM: yes',
  'load_backend: loaded CUDA backend from C:\\Users\\u\\AppData\\Roaming\\Atomic Chat\\data\\llamacpp-upstream\\backends\\b12019\\win-cuda-13.3-x64\\ggml-cuda.dll',
  "load_model: loading model 'C:\\Users\\u\\AppData\\Roaming\\Atomic Chat\\data\\llamacpp\\models\\demo\\model.gguf'",
  'CUDA error: the provided PTX was compiled with an unsupported toolchain.',
  '  current device: 0, in function ggml_cuda_kernel_can_use_pdl at D:\\a\\llama.cpp\\llama.cpp\\ggml\\src\\ggml-cuda\\common.cuh:1071',
  '  cudaFuncGetAttributes(&attr, kernel)',
  'D:\\a\\llama.cpp\\llama.cpp\\ggml\\src\\ggml-cuda\\ggml-cuda.cu:94: CUDA error',
  '',
].join('\n')

/** The same failure when the stderr tail kept only the location lines, not the CUDA error itself. */
export const CUDA13_PDL_LOCATION_ONLY_STDERR = [
  '  current device: 0, in function ggml_cuda_kernel_can_use_pdl at D:\\a\\llama.cpp\\llama.cpp\\ggml\\src\\ggml-cuda\\common.cuh:1071',
  '  cudaFuncGetAttributes(&attr, kernel)',
  'D:\\a\\llama.cpp\\llama.cpp\\ggml\\src\\ggml-cuda\\ggml-cuda.cu:94: CUDA error',
  '',
].join('\n')

/** A build without kernels for this architecture at all. */
export const CUDA_NO_KERNEL_IMAGE_STDERR = [
  'CUDA error: no kernel image is available for execution on the device',
  '  current device: 0, in function ggml_cuda_compute_forward at D:\\a\\llama.cpp\\llama.cpp\\ggml\\src\\ggml-cuda\\ggml-cuda.cu:2601',
  '  err',
  'D:\\a\\llama.cpp\\llama.cpp\\ggml\\src\\ggml-cuda\\ggml-cuda.cu:94: CUDA error',
  '',
].join('\n')

/** A `--device` value the build does not have (a ROCm or Vulkan build asked for `CUDA0`). */
export const UNKNOWN_DEVICE_STDERR = [
  'error while handling argument "--device": invalid device: CUDA0',
  '',
  'usage:',
  "-dev,  --device <dev1,dev2,..>            comma-separated list of devices to use for offloading (none = don't",
  '                                        offload)',
  '                                        use --list-devices to see a list of available devices',
  '                                        (env: LLAMA_ARG_DEVICE)',
  '',
].join('\n')

/** NTSTATUS exit codes as Node reports them on Windows (unsigned) and as some hosts pass them (signed). */
export const STATUS_DLL_NOT_FOUND = 0xc000_0135
export const STATUS_INVALID_IMAGE_FORMAT = 0xc000_007b
export const STATUS_DLL_INIT_FAILED = 0xc000_0142
export const STATUS_ILLEGAL_INSTRUCTION = 0xc000_001d
