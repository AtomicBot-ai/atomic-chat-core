import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeProbeDeps } from '../../test/helpers/fake-probe-deps.js'
import type { ProbeFs } from './probe-common.js'
import { nodeProbeDeps, nodeProbeFs, probeSystemInfo, runTool } from './probe.js'

const node = process.execPath

describe('runTool', () => {
  it('resolves stdout and the exit code, zero or not', async () => {
    await expect(runTool(node, ['-e', "process.stdout.write('hi')"], 5_000)).resolves.toEqual({
      stdout: 'hi',
      stderr: '',
      code: 0,
    })
    await expect(
      runTool(node, ['-e', "process.stderr.write('bad'); process.exit(3)"], 5_000)
    ).resolves.toEqual({
      stdout: '',
      stderr: 'bad',
      code: 3,
    })
  })

  it('rejects a tool that is not there, and one that does not finish in time', async () => {
    await expect(runTool('/definitely/not/a/tool', [], 1_000)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(runTool(node, ['-e', 'setTimeout(() => {}, 30000)'], 200)).rejects.toThrow(
      /did not finish in 200 ms/
    )
  })
})

describe('nodeProbeFs / nodeProbeDeps', () => {
  let dir: string | undefined
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('reads files, directories and symlinks, and answers exists without throwing', async () => {
    dir = await mkdtemp(join(tmpdir(), 'atomic-probe-fs-'))
    await writeFile(join(dir, 'vendor'), '0x10de\n')
    await symlink('../../../0000:01:00.0', join(dir, 'device'))
    expect(await nodeProbeFs.readFile(join(dir, 'vendor'))).toBe('0x10de\n')
    expect((await nodeProbeFs.readdir(dir)).sort()).toEqual(['device', 'vendor'])
    expect(await nodeProbeFs.readlink(join(dir, 'device'))).toBe('../../../0000:01:00.0')
    expect(await nodeProbeFs.exists(join(dir, 'vendor'))).toBe(true)
    expect(await nodeProbeFs.exists(join(dir, 'absent'))).toBe(false)
    await expect(nodeProbeFs.readFile(join(dir, 'absent'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('builds the real dependencies and lets any of them be replaced', () => {
    const deps = nodeProbeDeps()
    expect(deps.platform).toBe(process.platform)
    expect(deps.arch).toBe(process.arch)
    expect(deps.run).toBe(runTool)
    expect(deps.fs).toBe(nodeProbeFs)
    expect(deps.os.totalmem()).toBeGreaterThan(0)
    expect(deps.os.cpus().length).toBeGreaterThan(0)
    const over = nodeProbeDeps({ platform: 'linux', arch: 'arm64', env: { HOME: '/h' } })
    expect(over).toMatchObject({ platform: 'linux', arch: 'arm64', env: { HOME: '/h' } })
  })
})

describe('probeSystemInfo', () => {
  it('dispatches on the platform', async () => {
    const linux = await probeSystemInfo(
      fakeProbeDeps({ platform: 'linux', files: { '/proc/cpuinfo': 'flags\t: avx\n' } })
    )
    expect(linux.info.os_type).toBe('linux')
    expect(linux.info.cpu.extensions).toEqual(['fpu', 'avx'])
    const darwin = await probeSystemInfo(fakeProbeDeps({ platform: 'darwin', arch: 'arm64' }))
    expect(darwin.info).toMatchObject({ os_type: 'macos', gpus: [] })
    const windows = await probeSystemInfo(fakeProbeDeps({ platform: 'win32' }))
    expect(windows.info.os_type).toBe('windows')
    expect(windows.warnings.some((w) => w.startsWith('powershell:'))).toBe(true)
  })

  it('answers the node:os fallback for a platform without a probe', async () => {
    const result = await probeSystemInfo(
      fakeProbeDeps({ platform: 'freebsd', arch: 'x64', cpus: [{ model: 'Zen' }] })
    )
    expect(result.info).toMatchObject({
      os_type: 'unknown',
      os_name: 'freebsd',
      cpu: { name: 'Zen', extensions_known: false },
      gpus: [],
    })
    expect(result.warnings).toEqual(['no hardware probe for platform freebsd'])
  })

  it('turns a probe that throws into the fallback plus a warning, never a rejection', async () => {
    const deps = fakeProbeDeps({ platform: 'linux', arch: 'x64' })
    deps.fs = {} as ProbeFs
    const result = await probeSystemInfo(deps)
    expect(result.info).toMatchObject({
      os_type: 'linux',
      cpu: { arch: 'x86_64', extensions_known: false },
      gpus: [],
    })
    expect(result.warnings).toEqual([expect.stringMatching(/^hardware probe failed: .*readFile/)])
  })
})
