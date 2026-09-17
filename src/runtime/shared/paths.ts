/**
 * Path checks performed right before spawning. Port of
 * `src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/path.rs`.
 *
 * On Windows, non-ASCII model paths are passed as 8.3 short paths (llama.cpp opens files through
 * ANSI APIs), except for split shards whose `-NNNNN-of-NNNNN` marker the mangling would destroy.
 */

import { AtomicCoreError } from '../../contracts/index.js'

export interface PathDeps {
  platform: NodeJS.Platform
  exists: (path: string) => Promise<boolean>
  /** 8.3 short path on Windows (`GetShortPathNameW`); `undefined` when unavailable. */
  shortPath?: (path: string) => Promise<string | undefined>
}

export function needsShortPath(path: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/^[\x00-\x7F]*$/.test(path)
}

/** `*-NNNNN-of-NNNNN.gguf`, case-insensitive on the extension. */
export function isSplitGgufName(fileName: string): boolean {
  const lower = fileName.toLowerCase()
  if (!lower.endsWith('.gguf')) return false
  const stem = lower.slice(0, -'.gguf'.length)
  if (stem.length < 15) return false
  return /-\d{5}-of-\d{5}$/.test(stem)
}

export async function validateBinaryPath(
  backendPath: string,
  deps: Pick<PathDeps, 'exists'>
): Promise<string> {
  if (!(await deps.exists(backendPath))) {
    throw new AtomicCoreError(
      'BINARY_NOT_FOUND',
      'The llama.cpp server binary could not be found.',
      `Binary not found at ${JSON.stringify(backendPath)}`
    )
  }
  return backendPath
}

async function platformPath(path: string, isSplit: boolean, deps: PathDeps): Promise<string> {
  if (deps.platform !== 'win32' || isSplit || !needsShortPath(path) || !deps.shortPath) return path
  return (await deps.shortPath(path)) ?? path
}

/** Validate `-m <path>` in argv, rewrite it for the platform, return the validated path. */
export async function validateModelArgs(args: string[], deps: PathDeps): Promise<string> {
  const i = args.indexOf('-m')
  if (i < 0) throw new AtomicCoreError('MODEL_LOAD_FAILED', "Model path argument '-m' is missing.")
  const modelPath = args[i + 1]
  if (modelPath === undefined)
    throw new AtomicCoreError('MODEL_LOAD_FAILED', "Model path was not provided after '-m' flag.")
  if (!(await deps.exists(modelPath))) {
    throw new AtomicCoreError(
      'MODEL_FILE_NOT_FOUND',
      'The specified model file does not exist or is not accessible.',
      `Invalid or inaccessible model path: ${modelPath}`
    )
  }
  const fileName = modelPath.split(/[\\/]/).pop() ?? ''
  args[i + 1] = await platformPath(modelPath, isSplitGgufName(fileName), deps)
  return modelPath
}

/** Validate `--mmproj <path>` when present; `undefined` when the flag is absent. */
export async function validateMmprojArgs(args: string[], deps: PathDeps): Promise<string | undefined> {
  const i = args.indexOf('--mmproj')
  if (i < 0) return undefined
  const mmproj = args[i + 1]
  if (mmproj === undefined)
    throw new AtomicCoreError('MODEL_LOAD_FAILED', "Mmproj path was not provided after '--mmproj' flag.")
  if (!(await deps.exists(mmproj))) {
    throw new AtomicCoreError(
      'MODEL_FILE_NOT_FOUND',
      'The specified mmproj file does not exist or is not accessible.',
      `Invalid or inaccessible mmproj path: ${mmproj}`
    )
  }
  args[i + 1] = await platformPath(mmproj, false, deps)
  return mmproj
}
