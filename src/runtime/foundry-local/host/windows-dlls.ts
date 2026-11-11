/** Windows dependency search policy; applied only inside the isolated Foundry host. */
import { win32 } from 'node:path'
import { FOUNDRY_CUDA_CACHE_DIR } from '../cuda/index.js'

export function foundryWindowsCudaCache(env: NodeJS.ProcessEnv): string | undefined {
  const path = env[FOUNDRY_CUDA_CACHE_DIR]
  return path && win32.isAbsolute(path) ? win32.normalize(path) : undefined
}

export function foundryWindowsDllDirectories(
  libDir: string,
  env: Readonly<Record<string, string | undefined>>,
  discovered: readonly string[]
): string[] {
  const cache = foundryWindowsCudaCache(env)
  if (cache) return [win32.normalize(libDir), cache]
  const entries = Object.entries(env)
  const roots = entries
    .filter(([key]) => /^(CUDA_PATH(?:_V12_\d+)?|CUDNN_PATH)$/i.test(key))
    .flatMap(([, value]) => (value ? [win32.join(value, 'bin'), win32.join(value, 'bin', 'x64')] : []))
  const path = entries.find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
  const seen = new Set<string>()
  return [libDir, ...roots, ...discovered, ...path.split(';')].flatMap((value) => {
    const trimmed = value.trim().replace(/^"(.*)"$/, '$1')
    if (!win32.isAbsolute(trimmed)) return []
    const normalized = win32.normalize(trimmed)
    const key = normalized.toLowerCase().replace(/\\+$/, '')
    if (seen.has(key)) return []
    seen.add(key)
    return [normalized]
  })
}
