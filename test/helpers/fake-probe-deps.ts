/**
 * A scripted `ProbeDeps` for the hardware probe's platform branches: files, directories and symlinks
 * by path, tools by executable name, `node:os` numbers by value. What is not scripted fails the way
 * the real thing fails (`ENOENT`), and every tool run is recorded.
 */
import type { ProbeDeps, ToolResult } from '../../src/hardware/index.js'

export type FakeTool = ToolResult | Error | ((args: string[]) => ToolResult | Error)

export interface FakeProbeScript {
  platform: NodeJS.Platform | string
  arch?: string
  env?: NodeJS.ProcessEnv
  /** Path → contents. */
  files?: Record<string, string>
  /** Path → entries. */
  dirs?: Record<string, string[]>
  /** Path → symlink target. */
  links?: Record<string, string>
  /** Executable (as the probe names it) → what it answers. Unlisted tools are not installed. */
  tools?: Record<string, FakeTool>
  totalmem?: number
  cpus?: Array<{ model: string }>
}

export interface FakeProbeDeps extends ProbeDeps {
  calls: Array<{ file: string; args: string[]; timeoutMs: number }>
}

export const enoent = (path: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' })

export const ok = (stdout: string, stderr = ''): ToolResult => ({ stdout, stderr, code: 0 })
export const failed = (code: number, stderr: string, stdout = ''): ToolResult => ({ stdout, stderr, code })

export function fakeProbeDeps(script: FakeProbeScript): FakeProbeDeps {
  const files = script.files ?? {}
  const dirs = script.dirs ?? {}
  const links = script.links ?? {}
  const tools = script.tools ?? {}
  const calls: FakeProbeDeps['calls'] = []
  return {
    platform: script.platform,
    arch: script.arch ?? 'x64',
    env: script.env ?? {},
    calls,
    run: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      const tool = tools[file]
      if (tool === undefined) throw enoent(file)
      const answer = typeof tool === 'function' ? tool(args) : tool
      if (answer instanceof Error) throw answer
      return answer
    },
    fs: {
      readFile: async (path) => {
        if (path in files) return files[path] as string
        throw enoent(path)
      },
      readdir: async (path) => {
        if (path in dirs) return [...(dirs[path] as string[])]
        throw enoent(path)
      },
      exists: async (path) => path in files || path in dirs,
      readlink: async (path) => {
        if (path in links) return links[path] as string
        throw Object.assign(new Error(`EINVAL: invalid argument, readlink '${path}'`), { code: 'EINVAL' })
      },
    },
    os: {
      totalmem: () => script.totalmem ?? 64 * 2 ** 30,
      cpus: () => script.cpus ?? [{ model: 'Fake CPU' }, { model: 'Fake CPU' }],
    },
  }
}
