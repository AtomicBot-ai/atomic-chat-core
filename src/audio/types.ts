/**
 * What the audio module keeps for itself; nothing here crosses the wire as such.
 */

import type {
  AudioBackend,
  AudioCapabilities,
  AudioMode,
  AudioOptions,
  AudioTask,
} from '../contracts/index.js'
import type { ExitInfo } from '../runtime/llamacpp/index.js'

/**
 * Everything needed to (re)spawn `audiocpp_server` for one model. Kept after a cancel or a crash took
 * the process down, so the next job brings it back without the client repeating the load; cleared
 * only by an unload.
 */
export interface AudioServerSpec {
  /** Directory holding `audiocpp_server`; also the child's working directory. */
  binaryDir: string
  /** What `--backend` says: the build's backend, or `cpu` when `ATOMIC_AUDIO_BACKEND=cpu` forces it. */
  backend: AudioBackend
  /** The backend the build was made for. */
  buildBackend: AudioBackend
  backendId: string
  tag: string
  modelId: string
  displayName: string
  mode: AudioMode
  family: string
  task: AudioTask
  /** The model file or package directory, absolute. */
  modelPath: string
  loadOptions?: AudioOptions
  sessionOptions?: AudioOptions
  defaultRequestOptions?: AudioOptions
  defaultVoice?: string
  threads?: number
  startupTimeoutMs: number
}

/** A running `audiocpp_server`, as the session and the job runner see it; the real one wraps a child process. */
export interface AudioServerHandle {
  pid: number
  port: number
  exe: string
  /** What the server declared about the model once it was ready. */
  capabilities: AudioCapabilities
  /** The last lines the server printed, oldest first. */
  tail(): string[]
  /** Non-blocking liveness: the exit, once it has happened. */
  exitStatus(): ExitInfo | undefined
  exited: Promise<ExitInfo>
  /** SIGTERM, a grace period, then SIGKILL; resolves once the exit is confirmed. */
  terminate(graceMs?: number): Promise<ExitInfo>
}

export const DEFAULT_STARTUP_TIMEOUT_SECS = 600
export const DEFAULT_IDLE_UNLOAD_SECS = 600
/** A reference voice larger than this is refused before it reaches the engine. */
export const MAX_VOICE_REF_BYTES = 5 * 1024 * 1024
