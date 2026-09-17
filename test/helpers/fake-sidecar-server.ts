/**
 * Wiring for `fake-sidecar-server.mjs`, the stand-in for `foundation-models-server` and
 * `mlx-server`. As with the fake llama-server, only the executable is swapped: readiness markers,
 * fail-fast lines, exit classification and SIGTERM handling are the production code path.
 */
import { fileURLToPath } from 'node:url'
import { spawnAndAwaitReady } from '../../src/runtime/index.js'
import type { ReadyOptions, SpawnSpec } from '../../src/runtime/index.js'

export const FAKE_SIDECAR_SCRIPT = fileURLToPath(new URL('./fake-sidecar-server.mjs', import.meta.url))

export interface FakeSidecarOptions {
  kind: 'fm' | 'mlx'
  mode?: 'ready' | 'hang' | 'error-line' | 'exit-clean' | 'oom' | `exit-${number}`
  delayMs?: number
  argvFile?: string
  reason?: string
  check?: string
  minCtx?: number
}

export function fakeSidecarEnv(options: FakeSidecarOptions): Record<string, string> {
  const env: Record<string, string> = {
    FAKE_SIDECAR_KIND: options.kind,
    FAKE_SIDECAR_MODE: options.mode ?? 'ready',
  }
  if (options.delayMs) env['FAKE_SIDECAR_DELAY'] = String(options.delayMs)
  if (options.argvFile) env['FAKE_SIDECAR_ARGV'] = options.argvFile
  if (options.reason) env['FAKE_SIDECAR_REASON'] = options.reason
  if (options.check) env['FAKE_FM_CHECK'] = options.check
  if (options.minCtx) env['FAKE_MLX_MIN_CTX'] = String(options.minCtx)
  return env
}

/** Drop-in for a sidecar runtime's `spawn`: same readiness logic, fake executable. */
export function fakeSidecarSpawn(options: FakeSidecarOptions) {
  return (spec: SpawnSpec, opts: ReadyOptions) =>
    spawnAndAwaitReady(
      {
        exe: process.execPath,
        args: [FAKE_SIDECAR_SCRIPT, ...spec.args],
        env: { ...spec.env, ...fakeSidecarEnv(options) },
        ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
      },
      opts
    )
}

/**
 * An executable named like the real server (`<dir>/<name>`) that runs the fake, for code paths that
 * spawn a path rather than accept a spawn seam — the CLI, the compiled core. POSIX shells only; on
 * Windows the caller skips.
 */
export async function writeFakeSidecarBinary(
  dir: string,
  name: string,
  options: FakeSidecarOptions
): Promise<string> {
  const { chmod, mkdir, writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  await mkdir(dir, { recursive: true })
  const path = join(dir, name)
  const exports = Object.entries(fakeSidecarEnv(options))
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join('\n')
  await writeFile(
    path,
    `#!/bin/sh\n${exports}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_SIDECAR_SCRIPT)} "$@"\n`
  )
  await chmod(path, 0o755)
  return path
}
