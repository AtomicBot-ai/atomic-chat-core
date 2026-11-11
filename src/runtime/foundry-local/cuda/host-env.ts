import { basename } from 'node:path'

export const FOUNDRY_CUDA_CACHE_DIR = 'ATOMIC_FOUNDRY_CUDA_CACHE_DIR'

export function withCudaRuntime<Env extends NodeJS.ProcessEnv>(
  env: Env,
  build: string,
  directory: string
): Env {
  const windows = basename(build).startsWith('win-')
  const key = windows
    ? (Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'Path')
    : 'LD_LIBRARY_PATH'
  const current = env[key]
  return {
    ...env,
    ...(windows ? { [FOUNDRY_CUDA_CACHE_DIR]: directory } : {}),
    [key]: current ? `${directory}${windows ? ';' : ':'}${current}` : directory,
  }
}
