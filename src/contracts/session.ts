/**
 * Session shapes returned by `load()` and read by the app's `model-factory.ts` (port + api_key)
 * and by the Rust agent (`core_sessions` mirror). Byte-identical with
 * src-tauri/plugins/tauri-plugin-llamacpp-upstream/guest-js/types.ts:122-132 and state.rs:9-23.
 */

/**
 * `tensorrt-llm` runs in a container on Linux only (openspec change `add-tensorrt-llm-linux`); a core
 * on any other platform never offers it, and its sessions carry `pid: null`.
 *
 * `atomic-prism` is PrismML's llama.cpp fork, the only engine that runs Bonsai's Prism packings
 * (`PQ2_0`, `PTQ1_0`, the Hadamard transform). It shares the GGUF model tree with the two other
 * llama.cpp providers and never becomes the default for an ordinary model.
 */
export type LocalProviderId =
  'llamacpp-upstream' | 'llamacpp' | 'atomic-prism' | 'mlx' | 'foundation-models' | 'tensorrt-llm'

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

/**
 * How a session's backend actually runs. A native one is a process on this machine; a managed one
 * is a container, which has no host process id of its own — the Docker client that started it is
 * long gone, and the pid inside the container belongs to another kernel's numbering.
 *
 * Absent means `native`: every record written before managed runtimes existed is one.
 */
export type SessionExecutionKind = 'native' | 'container'

export interface SessionInfo {
  /**
   * The backend's process id on this machine, or null when it has none. Code that kills or probes
   * a process must go through `hostPid`, which refuses a session that is not a host process.
   */
  pid: number | null
  port: number
  model_id: string
  model_path: string
  is_embedding: boolean
  /** Bearer token the session expects; "" for MLX. */
  api_key: string
  mmproj_path?: string | null
  runtime_device?: RuntimeDeviceInfo | null
  /** Absent on every record a previous release wrote, and on every native one. */
  execution?: SessionExecutionKind
  /**
   * Changes each time this model is loaded again. A caller holding the previous generation is
   * addressing a session that no longer exists, rather than the one that replaced it.
   */
  generation?: string
}

/**
 * Stage of a managed-runtime model load, reported on `session:load-progress` (spec
 * `tensorrt-llm-runtime`, design D8): `stopping-previous` evicts whatever currently holds the GPU,
 * `starting-container` waits for the container itself, `initializing-engine` covers the engine
 * reading weights and preparing inside it — refined from the adapter's own log markers when it has
 * them — and `ready` is the terminal success. A native session never emits this: its readiness is a
 * single wait, not a staged one.
 */
export const SESSION_LOAD_STAGES = [
  'stopping-previous',
  'starting-container',
  'initializing-engine',
  'ready',
] as const
export type SessionLoadStage = (typeof SESSION_LOAD_STAGES)[number]

export interface UnloadResult {
  success: boolean
  error?: string
  /**
   * Whether the provider had the model at all — loading, ready, or stopping — when the unload began.
   * Set by `tensorrt-llm` only (task 2.24, spec `tensorrt-llm-runtime`), so a wrong id reads as
   * `false` rather than as a stopped model; the other providers leave it out and stay idempotent.
   */
  was_loaded?: boolean
}

/** One line of `llama-server --list-devices`, memory in MiB (Rust `DeviceInfo`). */
export interface DeviceInfo {
  id: string
  name: string
  mem: number
  free: number
}
