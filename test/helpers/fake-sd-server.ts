/**
 * Wiring for `fake-sd-server.mjs`: an engine tree under `<data>/diffusion/backends/<tag>/<backendId>/`
 * whose `sd-server` and `sd-cli` are launchers of the fake, so a core that finalizes, lists and
 * spawns an engine the ordinary way gets the fake one. POSIX only, like `fake-backend-pack.ts`: the
 * launchers are `#!/bin/sh` scripts.
 */
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DataLayout } from '../../src/config/index.js'
import { INSTALL_RECORD, OWNER_MARKER } from '../../src/diffusion/index.js'

export const FAKE_SD_SCRIPT = fileURLToPath(new URL('./fake-sd-server.mjs', import.meta.url))
export const CAN_INSTALL_FAKE_SD = process.platform !== 'win32'

export type FakeSdMode =
  'ready' | 'hang' | 'exit-early' | 'foreign' | 'queue-full' | 'fail-job' | 'die-mid-job' | 'ggml-abort'

export interface FakeSdOptions {
  mode?: FakeSdMode
  /** Milliseconds before the port is bound. */
  loadMs?: number
  /** Milliseconds per sampling step. */
  stepMs?: number
  /** Advertise and honour a cancel while generating. */
  cancel?: boolean
  /** Print a tiled-VAE pass of this many tiles before sampling. */
  tiles?: number
  exitCode?: number
  stderr?: string
  pidFile?: string
  argvFile?: string
  ignoreSigterm?: boolean
}

export function fakeSdEnv(options: FakeSdOptions): Record<string, string> {
  const env: Record<string, string> = { FAKE_SD_MODE: options.mode ?? 'ready' }
  if (options.loadMs !== undefined) env['FAKE_SD_LOAD_MS'] = String(options.loadMs)
  if (options.stepMs !== undefined) env['FAKE_SD_STEP_MS'] = String(options.stepMs)
  if (options.cancel) env['FAKE_SD_CANCEL'] = '1'
  if (options.tiles !== undefined) env['FAKE_SD_TILES'] = String(options.tiles)
  if (options.exitCode !== undefined) env['FAKE_SD_EXIT_CODE'] = String(options.exitCode)
  if (options.stderr !== undefined) env['FAKE_SD_STDERR'] = options.stderr
  if (options.pidFile) env['FAKE_SD_PID_FILE'] = options.pidFile
  if (options.argvFile) env['FAKE_SD_ARGV_FILE'] = options.argvFile
  if (options.ignoreSigterm) env['FAKE_SD_IGNORE_SIGTERM'] = '1'
  return env
}

export interface FakeSdEngine {
  dir: string
  tag: string
  backendId: string
}

/** Write the launchers into `dir` (created), with the fake's options baked into their environment. */
export async function writeFakeSdLaunchers(dir: string, options: FakeSdOptions = {}): Promise<void> {
  await mkdir(dir, { recursive: true })
  const exports = Object.entries(fakeSdEnv(options))
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join('\n')
  for (const name of ['sd-server', 'sd-cli']) {
    const path = join(dir, name)
    await writeFile(
      path,
      `#!/bin/sh\n${exports}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_SD_SCRIPT)} "$@"\n`
    )
    await chmod(path, 0o755)
  }
}

/** An installed, owned engine tree (marker and record included) whose binaries are the fake. */
export async function installFakeSdEngine(
  layout: DataLayout,
  options: FakeSdOptions & { tag?: string; backendId?: string } = {}
): Promise<FakeSdEngine> {
  const tag = options.tag ?? 'master-849-d04e895'
  const backendId = options.backendId ?? 'fake-cpu'
  const dir = join(layout.diffusion.backendsDir, tag, backendId)
  await writeFakeSdLaunchers(dir, options)
  await writeFile(join(dir, OWNER_MARKER), 'atomic-chat\n')
  await writeFile(
    join(dir, INSTALL_RECORD),
    JSON.stringify(
      { tag, backendId, backend: 'cpu', engine: 'sd-cpp', sha256: null, installedAtMs: 1 },
      null,
      2
    )
  )
  return { dir, tag, backendId }
}

/** A model file the load request can point at; the fake never reads it. */
export async function writeFakeSdModel(
  layout: DataLayout,
  name = 'z-image/z-image-turbo-Q4_K_M.gguf'
): Promise<string> {
  const path = join(layout.diffusion.modelsDir, ...name.split('/'))
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, 'GGUF fake')
  return path
}
