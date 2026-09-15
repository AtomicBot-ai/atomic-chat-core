/**
 * Session shapes returned by `load()` and read by the app's `model-factory.ts` (port + api_key)
 * and by the Rust agent (`core_sessions` mirror). Byte-identical with
 * src-tauri/plugins/tauri-plugin-llamacpp-upstream/guest-js/types.ts:122-132 and state.rs:9-23.
 */

export type LocalProviderId = 'llamacpp-upstream' | 'llamacpp' | 'mlx' | 'foundation-models'

export interface RuntimeDeviceInfo {
  /** Backends in load order, deduped, e.g. ["CUDA", "CPU"]. */
  loaded_backends: string[]
  /** "CUDA0" | "Vulkan0" | "Metal" | "CPU" | "" */
  primary_device: string
  gpu_layers_offloaded: number | null
  total_layers: number | null
  gpu_buffer_bytes: number | null
  cuda_runtime_missing: boolean
  device_init_error: string | null
}

export interface SessionInfo {
  pid: number
  port: number
  model_id: string
  model_path: string
  is_embedding: boolean
  /** Bearer token the session expects; "" for MLX. */
  api_key: string
  mmproj_path?: string | null
  runtime_device?: RuntimeDeviceInfo | null
}

export interface UnloadResult {
  success: boolean
  error?: string
}

/** One line of `llama-server --list-devices`, memory in MiB (Rust `DeviceInfo`). */
export interface DeviceInfo {
  id: string
  name: string
  mem: number
  free: number
}
