/**
 * Which device the loaded model actually runs on, derived from the `llama-server` startup log.
 * Port of `src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/runtime_device.rs`.
 * Pinned by `test/contract/runtime-device.test.ts`.
 *
 * `--list-devices` only says what a binary can enumerate; the startup log is the only signal that
 * tells a healthy GPU load from a CUDA/Vulkan build that silently degraded to CPU.
 */

import type { RuntimeDeviceInfo } from '../../contracts/index.js'
import { floatAsU64, parseRustF64, parseRustI32 } from '../../util/index.js'

const DEVICE_INIT_ERROR_MARKERS = [
  'failed to initialize CUDA',
  'no CUDA devices found',
  'error while loading shared libraries',
  'failed to load backend',
  'ggml_vulkan: No devices found',
  'no usable GPU found',
]

export function parseDeviceInitError(line: string): string | undefined {
  const trimmed = line.trim()
  return DEVICE_INIT_ERROR_MARKERS.some((m) => trimmed.includes(m)) ? trimmed : undefined
}

/** `load_backend: loaded CUDA backend from /path/libggml-cuda.so` → `CUDA` */
export function parseLoadedBackend(line: string): string | undefined {
  const i = line.indexOf('load_backend: loaded ')
  if (i < 0) return undefined
  const rest = line.slice(i + 'load_backend: loaded '.length)
  const j = rest.indexOf(' backend')
  if (j < 0) return undefined
  const name = rest.slice(0, j).trim()
  return name === '' ? undefined : name
}

/** `load_tensors: offloaded 33/33 layers to GPU` → [33, 33] */
export function parseOffloadedLayers(line: string): [number, number] | undefined {
  if (!line.includes('layers to GPU')) return undefined
  const i = line.indexOf('offloaded ')
  if (i < 0) return undefined
  const ratio = line
    .slice(i + 'offloaded '.length)
    .split(/\s+/)
    .find((t) => t !== '')
  if (ratio === undefined) return undefined
  const slash = ratio.indexOf('/')
  if (slash < 0) return undefined
  const offloaded = parseRustI32(ratio.slice(0, slash).trim())
  const total = parseRustI32(ratio.slice(slash + 1).trim())
  return offloaded === undefined || total === undefined ? undefined : [offloaded, total]
}

/** `load_tensors: offloading 32 repeating layers to GPU` → 32 */
export function parseRepeatingLayers(line: string): number | undefined {
  if (!line.includes('repeating layers to GPU')) return undefined
  const i = line.indexOf('offloading ')
  if (i < 0) return undefined
  const first = line
    .slice(i + 'offloading '.length)
    .split(/\s+/)
    .find((t) => t !== '')
  return first === undefined ? undefined : parseRustI32(first)
}

export function parseSize(text: string): number | undefined {
  const parts = text.split(/\s+/).filter((t) => t !== '')
  const value = parts[0] === undefined ? undefined : parseRustF64(parts[0])
  if (value === undefined) return undefined
  const unit = parts[1] ?? 'B'
  const multiplier = unit === 'GiB' ? 1024 ** 3 : unit === 'MiB' ? 1024 ** 2 : unit === 'KiB' ? 1024 : 1
  if (value < 0) return undefined
  return floatAsU64(value * multiplier)
}

/** `load_tensors:        CUDA0 model buffer size =  4155.99 MiB` → ['CUDA0', bytes] */
export function parseModelBuffer(line: string): [string, number] | undefined {
  const i = line.indexOf(' model buffer size =')
  if (i < 0) return undefined
  const head = line.slice(0, i)
  const tail = line.slice(i + ' model buffer size ='.length)
  if (!head.includes('load_tensors:')) return undefined
  const colon = head.lastIndexOf(':')
  if (colon < 0) return undefined
  const label = head.slice(colon + 1).trim()
  if (label === '') return undefined
  const bytes = parseSize(tail)
  return bytes === undefined ? undefined : [label, bytes]
}

const isCpuBufferLabel = (label: string) => label === 'CPU' || label.startsWith('CPU_')

export class RuntimeDeviceAccumulator {
  private loadedBackends: string[] = []
  private buffers = new Map<string, number>()
  private gpuLayersOffloaded: number | null = null
  private totalLayers: number | null = null
  private cudaRuntimeMissing = false
  private deviceInitError: string | null = null

  /** Recorded at spawn time by the CUDA-path probe, before any log line. */
  markCudaRuntimeMissing(): void {
    this.cudaRuntimeMissing = true
  }

  ingest(line: string): void {
    if (this.deviceInitError === null) {
      const err = parseDeviceInitError(line)
      if (err !== undefined) this.deviceInitError = err
    }
    const backend = parseLoadedBackend(line)
    if (backend !== undefined) {
      if (!this.loadedBackends.includes(backend)) this.loadedBackends.push(backend)
      return
    }
    const offloaded = parseOffloadedLayers(line)
    if (offloaded !== undefined) {
      this.gpuLayersOffloaded = offloaded[0]
      this.totalLayers = offloaded[1]
      return
    }
    const repeating = parseRepeatingLayers(line)
    if (repeating !== undefined) {
      if (this.gpuLayersOffloaded === null) this.gpuLayersOffloaded = repeating
      return
    }
    const buffer = parseModelBuffer(line)
    if (buffer !== undefined) {
      const [label, bytes] = buffer
      this.buffers.set(label, Math.max(this.buffers.get(label) ?? 0, bytes))
    }
  }

  snapshot(): RuntimeDeviceInfo {
    let largest: [string, number] | undefined
    for (const [label, bytes] of this.buffers) {
      if (isCpuBufferLabel(label) || bytes <= 0) continue
      // Larger wins; on a tie the lexicographically smaller label wins (deterministic splits).
      if (largest === undefined || bytes > largest[1] || (bytes === largest[1] && label < largest[0])) {
        largest = [label, bytes]
      }
    }
    const nothingOffloaded = this.gpuLayersOffloaded === 0
    const primaryDevice =
      largest !== undefined && !nothingOffloaded ? largest[0] : this.buffers.size > 0 ? 'CPU' : ''
    return {
      loaded_backends: [...this.loadedBackends],
      primary_device: primaryDevice,
      gpu_layers_offloaded: this.gpuLayersOffloaded,
      total_layers: this.totalLayers,
      gpu_buffer_bytes: largest === undefined ? null : largest[1],
      cuda_runtime_missing: this.cudaRuntimeMissing,
      device_init_error: this.deviceInitError,
    }
  }
}

/** True when the log carried nothing recognisable; callers must not conclude anything from it. */
export function isInconclusive(info: RuntimeDeviceInfo): boolean {
  return (
    info.loaded_backends.length === 0 &&
    info.primary_device === '' &&
    info.gpu_layers_offloaded === null &&
    !info.cuda_runtime_missing &&
    info.device_init_error === null
  )
}
