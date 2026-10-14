/**
 * Installing a real ggml-org `llama-server` as a `llamacpp-upstream` pack for the live suites, under
 * the tag and backend id production would use. The folder names *are* the registration: the tag
 * drives every build gate in `planLlamaArgs`, and on Windows a backend id outside
 * `determineSupportedBackends` is filtered out before the load (BINARY_NOT_FOUND).
 */
import { execFile } from 'node:child_process'
import { chmod, cp, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { determineSupportedBackends, normalizeFeatures } from '../../src/backend/select/features.js'
import { parseBinaryVersion } from '../../src/backend/version.js'
import { llamaServerExeName } from '../../src/config/index.js'
import { osTypeOf, rustArch } from '../../src/hardware/facts.js'

const run = promisify(execFile)

/** The CPU backend id core offers this host: `linux-cpu-x64`, `win-cpu-arm64`, `macos-arm64`, … */
export function hostUpstreamBackendId(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string {
  const [id] = determineSupportedBackends(osTypeOf(platform), rustArch(arch), normalizeFeatures(null))
  if (id === undefined) throw new Error(`no upstream backend for ${platform}-${arch}`)
  return id
}

/** `llama-server --version`, run beside its libraries, and the build number core parses out of it. */
export async function readVersion(exe: string): Promise<{ output: string; build: number | undefined }> {
  const { stdout, stderr } = await run(exe, ['--version'], { cwd: dirname(exe), timeout: 60_000 })
  const output = `${stdout}\n${stderr}`
  return { output, build: parseBinaryVersion(output) }
}

/**
 * The tag the binary is installed under: `ATOMIC_LIVE_UPSTREAM_TAG` when set (CI exports the release
 * it downloaded), otherwise `b<build>` from `--version`. Neither working means the version output
 * changed shape, which is itself a break worth a red test.
 */
export async function liveUpstreamTag(exe: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const fromEnv = env['ATOMIC_LIVE_UPSTREAM_TAG']
  if (fromEnv) return fromEnv
  const { output, build } = await readVersion(exe)
  if (build === undefined)
    throw new Error(
      `cannot read a build number from ${exe} --version; set ATOMIC_LIVE_UPSTREAM_TAG\n${output}`
    )
  return `b${build}`
}

/**
 * Copy the binary's whole folder (llama-server links against the ggml libraries beside it) into
 * `<backendsDir>/<tag>/<backendId>/build/bin` and return the installed executable.
 */
export async function installUpstreamPack(
  backendsDir: string,
  exe: string,
  tag: string,
  backendId: string = hostUpstreamBackendId()
): Promise<string> {
  const packDir = join(backendsDir, tag, backendId, 'build', 'bin')
  await mkdir(packDir, { recursive: true })
  await cp(dirname(exe), packDir, { recursive: true })
  const installed = join(packDir, llamaServerExeName(process.platform))
  if (process.platform !== 'win32') await chmod(installed, 0o755)
  return installed
}
