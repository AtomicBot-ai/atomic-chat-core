/**
 * On-disk layout under `<data>`. Every path here is a contract with the app (PLAN.md §8.1):
 *
 *   <data>/llamacpp/models/<id>/{model.yml, model.gguf, mmproj.gguf, *.part, *.tmp, *.url}  (shared by both llama.cpp providers)
 *   <data>/llamacpp/backends/<version>/<backend>/build/bin/llama-server        (turboquant)
 *   <data>/llamacpp/lib/                                                        (turboquant cudart)
 *   <data>/llamacpp-upstream/backends/<version>/<backend>/build/bin/llama-server
 *   <data>/llamacpp-upstream/tmp/
 *   <data>/mlx/models/<id>/{model.yml, config.json, *.safetensors}
 *   <data>/local-api-server.json, <data>/atomic-chatgpt-auth.json
 *   <data>/atomic-core/  — the only new folder (settings, credentials, lock, journal, logs)
 */

import { join, relative, sep } from 'node:path'
import type { LocalProviderId } from '../contracts/index.js'

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
  settings: string
  credentials: string
  optimalBackend: string
  instanceLock: string
  controlToken: string
  processes: string
  logsDir: string
}

export interface DataLayout {
  root: string
  serverStateFile: string
  chatgptAuthFile: string
  core: CoreFiles
  provider(id: LocalProviderId): ProviderPaths
}

export function dataLayout(root: string): DataLayout {
  const coreDir = join(root, CORE_DIR)
  return {
    root,
    serverStateFile: join(root, LOCAL_API_SERVER_STATE_FILE),
    chatgptAuthFile: join(root, CHATGPT_AUTH_FILE),
    core: {
      dir: coreDir,
      settings: join(coreDir, 'settings.json'),
      credentials: join(coreDir, 'credentials.json'),
      optimalBackend: join(coreDir, 'optimal-backend.json'),
      instanceLock: join(coreDir, 'instance.lock'),
      controlToken: join(coreDir, 'control-token'),
      processes: join(coreDir, 'processes.json'),
      logsDir: join(coreDir, 'logs'),
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
