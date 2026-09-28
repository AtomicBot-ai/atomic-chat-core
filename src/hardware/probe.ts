/**
 * The hardware probe's runner and dispatcher: the real `node:*` dependencies, and `probeSystemInfo`,
 * which picks the branch for `deps.platform`.
 *
 * A probe never throws for a missing tool, a refused file or a timeout: each becomes one line in
 * `warnings`, and the answer carries what could be read. The only way a platform probe rejects is a
 * bug; `probeSystemInfo` turns even that into the `node:os` fallback plus a warning.
 */

import { execFile } from 'node:child_process'
import { readFile, readdir, readlink, stat } from 'node:fs/promises'
import { cpus, totalmem } from 'node:os'
import { PROBE_MAX_OUTPUT_BYTES, fallbackProbe, warningOf } from './probe-common.js'
import type { HardwareProbeResult, ProbeDeps, ProbeFs, ToolResult } from './probe-common.js'
import { probeDarwin } from './probe-darwin.js'
import { probeLinux } from './probe-linux.js'
import { probeWindows } from './probe-windows.js'

/** `execFile` with the probe's rules: hidden window, a deadline, a bounded buffer, exit code as data. */
export function runTool(file: string, args: string[], timeoutMs: number): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: PROBE_MAX_OUTPUT_BYTES, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (!error) return resolve({ stdout, stderr, code: 0 })
        const failure = error as Error & { code?: string | number; killed?: boolean; signal?: string | null }
        if (failure.killed || failure.signal)
          return reject(
            new Error(`${file} did not finish in ${timeoutMs} ms (${failure.signal ?? 'killed'})`)
          )
        // A non-zero exit arrives as an error whose `code` is the number; a spawn failure has a string code.
        if (typeof failure.code === 'number') return resolve({ stdout, stderr, code: failure.code })
        reject(error)
      }
    )
  })
}

export const nodeProbeFs: ProbeFs = {
  readFile: (path) => readFile(path, 'utf8'),
  readdir: (path) => readdir(path),
  exists: (path) =>
    stat(path).then(
      () => true,
      () => false
    ),
  readlink: (path) => readlink(path),
}

/** The real dependencies, with any of them replaced. */
export function nodeProbeDeps(over: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    run: runTool,
    fs: nodeProbeFs,
    os: { totalmem, cpus },
    ...over,
  }
}

/** Measure the machine `deps` describes. A platform without a probe answers what `node:os` knows. */
export async function probeSystemInfo(deps: ProbeDeps): Promise<HardwareProbeResult> {
  try {
    if (deps.platform === 'linux') return await probeLinux(deps)
    if (deps.platform === 'win32') return await probeWindows(deps)
    if (deps.platform === 'darwin') return await probeDarwin(deps)
    return { ...fallbackProbe(deps), warnings: [`no hardware probe for platform ${String(deps.platform)}`] }
  } catch (error) {
    return { ...fallbackProbe(deps), warnings: [warningOf('hardware probe failed', error)] }
  }
}
