/**
 * On-disk layout under `<data>`. Every path here is a contract with the app (PLAN.md §8.1):
 *
 *   <data>/llamacpp/models/<id>/{model.yml, model.gguf, mmproj.gguf, *.part, *.tmp, *.url}  (shared by both llama.cpp providers)
 *   <data>/llamacpp/backends/<version>/<backend>/build/bin/llama-server        (turboquant)
 *   <data>/llamacpp/lib/                                                        (turboquant cudart)
 *   <data>/llamacpp-upstream/backends/<version>/<backend>/build/bin/llama-server
 *   <data>/llamacpp-upstream/tmp/
 *   <data>/mlx/models/<id>/{model.yml, config.json, *.safetensors}
 *   <data>/diffusion/{backends/<tag>/<backend>/, models/, scratch/}, <data>/images/  (image generation; the app's paths since v2.0.38)
 *   <data>/local-api-server.json, <data>/atomic-chatgpt-auth.json
 *   <data>/remote-access-tunnel.json  (the app's 2.0.40 tunnel journal: reaped once at startup, never written)
 *   <data>/atomic-core/  — the only new folder (settings, credentials, lock, journal, logs)
 *   <data>/atomic-core/managed-runtimes/{executions,heartbeats,artifacts,caches}/  (managed text runtimes, per scope)
 *   <dataDir>/atomic-managed-runtimes/{environment.json, environment.lock, installations/, operations/}
 *                                                        (managed text runtimes, shared by the app and CLI scopes)
 */

import { join, relative, sep } from 'node:path'
import { AtomicCoreError, type ArtifactLocation, type LocalProviderId } from '../contracts/index.js'
import { dataDir, type DataFolderEnv } from './data-folder.js'

/** Subfolder holding the shared GGUF tree: `<data>/llamacpp/models`. Not the provider id. */
export const MODELS_ROOT = 'llamacpp'
export const CORE_DIR = 'atomic-core'
export const MODEL_YML = 'model.yml'
export const LOCAL_API_SERVER_STATE_FILE = 'local-api-server.json'
export const CHATGPT_AUTH_FILE = 'atomic-chatgpt-auth.json'

export interface ProviderPaths {
  /** `<data>/<provider>` */
  root: string
  /** `<root>/backends` (llama.cpp providers only). */
  backendsDir: string
  /** `<root>/tmp` archive staging. */
  tmpDir: string
  /** `<data>/llamacpp/lib` — turboquant only. */
  libDir?: string
  /** `<data>/llamacpp/models` for both llama.cpp providers; `<data>/mlx/models` for MLX. */
  modelsDir: string
}

export interface CoreFiles {
  dir: string
  /**
   * The core's own copy of the local-API-server state, in the same schema as the app's
   * `<data>/local-api-server.json`. The app owns that file until phase 4, and two writers would
   * fight over it, so a core that serves `/v1` publishes its address here instead.
   */
  publicServerState: string
  settings: string
  credentials: string
  optimalBackend: string
  instanceLock: string
  controlToken: string
  processes: string
  modelClaims: string
  logsDir: string
  /** The remote-access tunnel's own crash-recovery record (it has no provider, model or port). */
  remoteAccessTunnel: string
  /** An empty `--config` for cloudflared on Windows, which has no `/dev/null` to point at. */
  cloudflaredEmptyConfig: string
}

/** Image generation. Paths the app's diffusion plugin chose; the core adopted them as they are. */
export interface DiffusionPaths {
  /** `<data>/diffusion` */
  root: string
  /** `<root>/backends/<tag>/<backendId>/`, each holding `sd-server`. */
  backendsDir: string
  modelsDir: string
  /** Empty directories `sd-server` insists on being given (LoRA, upscalers, embeddings). */
  scratchDir: string
  /** `<data>/images`: the gallery, unless the user chose another folder. */
  defaultOutputDir: string
}

export interface DataLayout {
  root: string
  serverStateFile: string
  chatgptAuthFile: string
  /** `<data>/atomic-core/managed-runtimes` — this scope's half of the managed-runtime layout. */
  managed: ManagedScopePaths
  /**
   * The tunnel journal Atomic Chat 2.0.40's Rust wrote (`{pid, started_at_secs}`) and reaped at its own
   * startup. The app no longer reads it, so the core reaps it once and removes it; nothing writes it.
   */
  legacyRemoteAccessTunnel: string
  core: CoreFiles
  diffusion: DiffusionPaths
  provider(id: LocalProviderId): ProviderPaths
}

export function dataLayout(root: string): DataLayout {
  const coreDir = join(root, CORE_DIR)
  const diffusionDir = join(root, 'diffusion')
  return {
    root,
    serverStateFile: join(root, LOCAL_API_SERVER_STATE_FILE),
    chatgptAuthFile: join(root, CHATGPT_AUTH_FILE),
    managed: managedScopePaths(coreDir),
    legacyRemoteAccessTunnel: join(root, 'remote-access-tunnel.json'),
    core: {
      dir: coreDir,
      publicServerState: join(coreDir, LOCAL_API_SERVER_STATE_FILE),
      settings: join(coreDir, 'settings.json'),
      credentials: join(coreDir, 'credentials.json'),
      optimalBackend: join(coreDir, 'optimal-backend.json'),
      instanceLock: join(coreDir, 'instance.lock'),
      controlToken: join(coreDir, 'control-token'),
      processes: join(coreDir, 'processes.json'),
      modelClaims: join(coreDir, 'model-claims'),
      logsDir: join(coreDir, 'logs'),
      remoteAccessTunnel: join(coreDir, 'remote-access-tunnel.json'),
      cloudflaredEmptyConfig: join(coreDir, 'cloudflared-empty.yml'),
    },
    diffusion: {
      root: diffusionDir,
      backendsDir: join(diffusionDir, 'backends'),
      modelsDir: join(diffusionDir, 'models'),
      scratchDir: join(diffusionDir, 'scratch'),
      defaultOutputDir: join(root, 'images'),
    },
    provider(id) {
      const providerRoot = join(root, id)
      switch (id) {
        case 'llamacpp':
          return {
            root: providerRoot,
            backendsDir: join(providerRoot, 'backends'),
            tmpDir: join(providerRoot, 'tmp'),
            libDir: join(providerRoot, 'lib'),
            modelsDir: join(root, MODELS_ROOT, 'models'),
          }
        case 'llamacpp-upstream':
          return {
            root: providerRoot,
            backendsDir: join(providerRoot, 'backends'),
            tmpDir: join(providerRoot, 'tmp'),
            modelsDir: join(root, MODELS_ROOT, 'models'),
          }
        case 'mlx':
        case 'foundation-models':
          return {
            root: providerRoot,
            backendsDir: join(providerRoot, 'backends'),
            tmpDir: join(providerRoot, 'tmp'),
            modelsDir: join(providerRoot, 'models'),
          }
      }
    },
  }
}

/** `llama-server` / `llama-server.exe` by platform. */
export function llamaServerExeName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'llama-server.exe' : 'llama-server'
}

/** Both layouts a backend pack may have: `build/bin/<exe>` (current) or flat `<exe>` (legacy). */
export function backendExeCandidates(
  paths: ProviderPaths,
  version: string,
  backend: string,
  exe: string
): string[] {
  const dir = join(paths.backendsDir, version, backend)
  return [join(dir, 'build', 'bin', exe), join(dir, exe)]
}

/** Model id from the directory holding its `model.yml`: relative to `modelsDir`, `\` → `/`. */
export function modelIdFromDir(modelsDir: string, modelDir: string): string {
  return relative(modelsDir, modelDir).split(sep).join('/')
}

/** Directory of a model id (ids may contain `/`, which nests). */
export function modelDirFromId(modelsDir: string, modelId: string): string {
  return join(modelsDir, ...modelId.split('/'))
}

/**
 * Resolve a `model.yml` path field: absolute paths stay, relative ones are joined onto `<data>`
 * (`resolve_model_by_id` in `cli/mod.rs`, `joinPath([janDataFolderPath, model_path])` in the extension).
 */
export function resolveDataRelative(root: string, path: string, isAbsolute: (p: string) => boolean): string {
  return isAbsolute(path) ? path : join(root, path)
}

// ── Managed text runtimes ────────────────────────────────────────────────────────────────────────

/**
 * The managed runtime layout has two halves, because the container environment and the models are
 * owned by different things.
 *
 * The **environment** — the Docker engine on Linux, the WSL distribution and its Docker on Windows —
 * belongs to the machine's user account, not to a data folder. Both the app scope and the CLI scope
 * drive the same one, so its record lives at a fixed per-user location and survives a data-folder
 * move untouched. Duplicating it per scope would mean two copies of a 16 GB image for one user.
 *
 * Everything a scope owns alone — its running containers, their heartbeats, its model artifacts and
 * its private caches — stays under that scope's `<data>/atomic-core/`, so app and CLI still cannot
 * stop each other's containers or share a half-written download.
 */

/** Overrides the shared per-user root. Tests and e2e set it so they never touch a real machine. */
export const MANAGED_ROOT_ENV = 'ATOMIC_CORE_MANAGED_ROOT'
/** Shared per-user root under `dataDir`, beside the app's own folders. */
export const MANAGED_SHARED_DIR = 'atomic-managed-runtimes'
/** Per-scope subtree under `<data>/atomic-core/`. */
export const MANAGED_SCOPE_DIR = 'managed-runtimes'

const UNRESERVED = /^[A-Za-z0-9._-]$/
/** Names Windows refuses whatever the extension follows them: `CON`, `nul.json`, `LPT1.txt`. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

const percent = (byte: number): string => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`

/**
 * One identifier as one directory name. Managed ids are opaque values that may hold anything a
 * model repository or an engine name does — `/`, `:`, spaces, any script — so they are never
 * spelled onto disk raw. Every byte outside `[A-Za-z0-9._-]` becomes `%XX` of its UTF-8 encoding,
 * which keeps the common case readable, keeps the result a single path segment, and is reversible
 * because `%` itself is always encoded.
 *
 * The three shapes that are legal characters but illegal names are escaped too: `.` and `..`, a
 * trailing dot, and the Windows device names.
 *
 * The result is therefore always exactly one path segment — it holds no separator and is never `.`
 * or `..` — which is what lets every builder below join it onto a root without re-checking. That
 * invariant is asserted directly in `paths.test.ts`; loosening the character set breaks it.
 */
export function encodeManagedId(id: string): string {
  if (id === '') throw new AtomicCoreError('INVALID_ARGUMENT', 'A managed id cannot be empty.')
  let out = ''
  for (const byte of encoder.encode(id)) {
    const ch = String.fromCharCode(byte)
    out += UNRESERVED.test(ch) ? ch : percent(byte)
  }
  if (/^\.+$/.test(out)) return out.replace(/\./g, '%2E')
  out = out.replace(/\.+$/, (run) => '%2E'.repeat(run.length))
  if (WINDOWS_DEVICE.test(out)) out = percent(out.charCodeAt(0)) + out.slice(1)
  return out
}

/** The inverse of `encodeManagedId`, for reading an id back off a directory listing. */
export function decodeManagedId(segment: string): string {
  const bytes: number[] = []
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i] as string
    if (ch !== '%') {
      bytes.push(ch.charCodeAt(0))
      continue
    }
    const hex = segment.slice(i + 1, i + 3)
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
      throw new AtomicCoreError('INVALID_ARGUMENT', `Not an encoded managed id: ${segment}`)
    }
    bytes.push(Number.parseInt(hex, 16))
    i += 2
  }
  try {
    return decoder.decode(new Uint8Array(bytes))
  } catch {
    throw new AtomicCoreError('INVALID_ARGUMENT', `Not an encoded managed id: ${segment}`)
  }
}

/**
 * The host path of an artifact, refusing a guest one. A path inside a WSL distribution is not a
 * Windows path: opening `/home/atomic/...` from the Windows side either fails or, worse, resolves
 * to something else entirely. Callers that need guest bytes go through the guest transport.
 */
export function managedHostPath(location: ArtifactLocation): string {
  if (location.kind === 'guest') {
    throw new AtomicCoreError(
      'INVALID_ARGUMENT',
      `A guest path is not a host path: ${location.guest_path} in ${location.environment_id}.`
    )
  }
  return location.absolute_path
}

/** What one scope owns: its containers, their heartbeats, its model bytes and its private caches. */
export interface ManagedScopePaths {
  /** `<data>/atomic-core/managed-runtimes` */
  root: string
  executionsDir: string
  heartbeatsDir: string
  artifactsDir: string
  cachesDir: string
  /** The private container-authority record of one running session. */
  executionFile(executionId: string): string
  /** The file the core touches while a session lives; the container's watchdog watches its age. */
  heartbeatFile(executionId: string): string
  artifactDir(artifactId: string): string
  /** Caches are per engine, per release and per model: nothing here is shared between engines. */
  cacheDir(engineId: string, descriptorId: string, artifactId: string): string
}

/** What the machine's user owns: the container environment and which engines are installed in it. */
export interface ManagedSharedPaths {
  root: string
  /** Executor kind, host recipe and, on Windows, the owned distribution's registration. */
  environmentFile: string
  /** Held for the length of any mutation, so an app core and a CLI core cannot interleave writes. */
  lockFile: string
  installationsDir: string
  operationsDir: string
  installationFile(installationId: string): string
  operationFile(operationId: string): string
}

export function managedScopePaths(coreDir: string): ManagedScopePaths {
  const root = join(coreDir, MANAGED_SCOPE_DIR)
  const executionsDir = join(root, 'executions')
  const heartbeatsDir = join(root, 'heartbeats')
  const artifactsDir = join(root, 'artifacts')
  const cachesDir = join(root, 'caches')
  return {
    root,
    executionsDir,
    heartbeatsDir,
    artifactsDir,
    cachesDir,
    executionFile: (executionId) => join(executionsDir, `${encodeManagedId(executionId)}.json`),
    heartbeatFile: (executionId) => join(heartbeatsDir, encodeManagedId(executionId)),
    artifactDir: (artifactId) => join(artifactsDir, encodeManagedId(artifactId)),
    cacheDir: (engineId, descriptorId, artifactId) =>
      join(cachesDir, encodeManagedId(engineId), encodeManagedId(descriptorId), encodeManagedId(artifactId)),
  }
}

export function managedSharedPaths(root: string): ManagedSharedPaths {
  const installationsDir = join(root, 'installations')
  const operationsDir = join(root, 'operations')
  return {
    root,
    environmentFile: join(root, 'environment.json'),
    lockFile: join(root, 'environment.lock'),
    installationsDir,
    operationsDir,
    installationFile: (installationId) =>
      join(installationsDir, encodeManagedId(installationId), 'installation.json'),
    operationFile: (operationId) => join(operationsDir, `${encodeManagedId(operationId)}.json`),
  }
}

/**
 * The shared root: the env override, else a fixed folder under `dataDir`. Deliberately not derived
 * from `<data>` — the environment is the user's, and moving the data folder must not strand the
 * containers, nor make the CLI scope install its own copy of the same image.
 */
export function managedSharedRoot(e: DataFolderEnv): string {
  const override = e.env[MANAGED_ROOT_ENV]
  if (override !== undefined && override.trim() !== '') return override
  return join(dataDir(e), MANAGED_SHARED_DIR)
}
