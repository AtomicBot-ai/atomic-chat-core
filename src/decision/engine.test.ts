import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dataLayout } from '../config/index.js'
import { AtomicCoreError } from '../contracts/index.js'
import { checkSpecTypeSupport } from '../runtime/llamacpp/index.js'
import { fakeLlamaSpawnRaw } from '../../test/helpers/fake-llama-server.js'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import { DECISION_CONVERT_FLAG, DECISION_FLAG, DecisionEngineResolver } from './engine.js'
import type { InstalledEnginePack } from './engine-candidates.js'

let data: TmpDataFolder

/** The error a promise rejects with; a promise that resolves fails the test. */
const rejection = <T>(p: Promise<unknown>): Promise<T> =>
  p.then(
    () => {
      throw new Error('expected a rejection')
    },
    (e: unknown) => e as T
  )

beforeEach(async () => {
  data = await makeTmpDataFolder()
})
afterEach(() => data.cleanup())

const pack = (version: string, backend: string): InstalledEnginePack => ({
  version,
  backend,
  path: `/packs/${version}/${backend}/llama-server`,
})

function resolver(packs: InstalledEnginePack[], supported: Set<string>, probes: string[] = []) {
  return new DecisionEngineResolver({
    layout: dataLayout(data.root),
    listPacks: async () => packs,
    mtime: async () => 1,
    probe: async (exe) => {
      probes.push(exe)
      return supported.has(exe)
    },
  })
}

describe('DecisionEngineResolver', () => {
  it('takes the first pack in gate order whose -h lists --decision', async () => {
    const probes: string[] = []
    const packs = [pack('b10269-1.5.1', 'macos-arm64'), pack('b10300-1.7.0', 'macos-arm64')]
    const info = await resolver(packs, new Set([packs[1]!.path, packs[0]!.path]), probes).resolve()
    expect(info).toEqual({
      path: packs[1]!.path,
      version_backend: 'b10300-1.7.0/macos-arm64',
      fork_version: '1.7.0',
      version_gate: true,
      dialect: 'turboquant',
      provider: 'llamacpp',
    })
    expect(probes).toEqual([packs[1]!.path])
  })

  it('still finds a dev build whose tag is older than 1.7.0, after the newer tags failed', async () => {
    const packs = [pack('b10300-1.7.0', 'macos-arm64'), pack('b10269-1.5.1', 'macos-arm64')]
    const info = await resolver(packs, new Set([packs[1]!.path])).resolve()
    expect(info).toMatchObject({ version_backend: 'b10269-1.5.1/macos-arm64', version_gate: false })
  })

  it('names every pack it tried when none serves the decision model', async () => {
    const packs = [pack('b10269-1.6.0', 'linux-x64-cpu')]
    const error = await rejection<{ code: string; details: string }>(resolver(packs, new Set()).resolve())
    expect(error).toMatchObject({ code: 'DECISION_ENGINE_UNSUPPORTED' })
    expect(error.details).toContain(`b10269-1.6.0/linux-x64-cpu: ${DECISION_FLAG} is not in its -h output`)
  })

  it('requires --decision-convert-cache for a checkpoint folder, and passes over a build without it', async () => {
    const packs = [pack('b10300-1.7.1', 'macos-arm64'), pack('b10300-1.7.0', 'macos-arm64')]
    const asked: string[] = []
    const r = new DecisionEngineResolver({
      layout: dataLayout(data.root),
      listPacks: async () => packs,
      mtime: async () => 1,
      probe: async (exe, flag) => {
        asked.push(`${exe} ${flag}`)
        return flag === DECISION_FLAG || exe === packs[1]!.path
      },
    })
    expect(await r.resolve('', { checkpointDir: true })).toMatchObject({ path: packs[1]!.path })
    // A GGUF needs only --decision: the first build serves it, from the remembered probe.
    expect(await r.resolve('')).toMatchObject({ path: packs[0]!.path })
    expect(asked).toEqual([
      `${packs[0]!.path} ${DECISION_FLAG}`,
      `${packs[0]!.path} ${DECISION_CONVERT_FLAG}`,
      `${packs[1]!.path} ${DECISION_FLAG}`,
      `${packs[1]!.path} ${DECISION_CONVERT_FLAG}`,
    ])
    const error = await rejection<{ details: string }>(
      new DecisionEngineResolver({
        layout: dataLayout(data.root),
        listPacks: async () => [packs[0]!],
        mtime: async () => 1,
        probe: async (_exe, flag) => flag === DECISION_FLAG,
      }).resolve('', { checkpointDir: true })
    )
    expect(error.details).toContain(`${DECISION_CONVERT_FLAG} is not in its -h output`)
  })

  it.skipIf(process.platform === 'win32')(
    'runs the real -h of an executable for each flag it needs',
    async () => {
      const help = (lines: string[]) =>
        data.writeBackend(
          'llamacpp',
          'b10269-1.7.0',
          'macos-arm64',
          `#!/bin/sh\necho '${lines.join("'\necho '")}'\n`
        )
      const r = () => new DecisionEngineResolver({ layout: dataLayout(data.root), platform: 'darwin' })
      const exe = await help([`  ${DECISION_FLAG}`, `  ${DECISION_CONVERT_FLAG} DIR`])
      expect(await r().resolve(exe, { checkpointDir: true })).toMatchObject({ path: exe })
      await help([`  ${DECISION_FLAG}`])
      await expect(r().resolve(exe, { checkpointDir: true })).rejects.toMatchObject({
        code: 'DECISION_ENGINE_UNSUPPORTED',
        details: `${exe}: ${DECISION_CONVERT_FLAG} is not in its -h output`,
      })
    }
  )

  it.skipIf(process.platform === 'win32')(
    'takes a -h that crashed for no evidence: the start fails, the engine is not called unsupported',
    async () => {
      const exe = await data.writeBackend(
        'llamacpp',
        'b10298-2.0.0',
        'macos-arm64',
        "#!/bin/sh\necho 'dyld: Library not loaded: libggml.dylib' >&2\nexit 134\n"
      )
      const error = await rejection<AtomicCoreError>(
        new DecisionEngineResolver({ layout: dataLayout(data.root), platform: 'darwin' }).resolve()
      )
      expect(error.code).toBe('MODEL_LOAD_FAILED')
      expect(error.details).toContain(`${exe} exited with code 134 after`)
      expect(error.details).toContain('dyld: Library not loaded: libggml.dylib')
    }
  )

  it('says where it looked when nothing is installed', async () => {
    const error = await rejection<{ details: string }>(resolver([], new Set()).resolve())
    expect(error.details).toContain(join('llamacpp', 'backends'))
  })

  it('remembers a verdict per executable and modification time, but not a probe that could not run', async () => {
    let calls = 0
    let mtime = 1
    let crash = true
    const r = new DecisionEngineResolver({
      layout: dataLayout(data.root),
      listPacks: async () => [pack('b1-1.7.0', 'cpu')],
      mtime: async () => mtime,
      probe: async () => {
        calls++
        if (crash) throw new Error('spawn EACCES')
        return true
      },
    })
    await expect(r.resolve()).rejects.toMatchObject({
      code: 'MODEL_LOAD_FAILED',
      details: expect.stringContaining('probe failed: spawn EACCES'),
    })
    crash = false
    await r.resolve()
    await r.resolve()
    expect(calls).toBe(2)
    mtime = 2
    await r.resolve()
    expect(calls).toBe(3)
  })

  it('fails with the probe timeout, not as unsupported, when the only build could not be checked', async () => {
    const r = new DecisionEngineResolver({
      layout: dataLayout(data.root),
      listPacks: async () => [pack('b10298-2.0.0', 'macos-arm64')],
      mtime: async () => 1,
      probe: async () => {
        throw new AtomicCoreError(
          'MODEL_LOAD_TIMED_OUT',
          'Timed out while probing llama.cpp backend capabilities.',
          'llama-server -h did not finish within 30s'
        )
      },
    })
    const error = await rejection<AtomicCoreError>(r.resolve())
    expect(error.code).toBe('MODEL_LOAD_TIMED_OUT')
    expect(error.message).toBe(
      'Could not check whether the installed engine serves the decision model: Timed out while probing llama.cpp backend capabilities.'
    )
    expect(error.message).not.toContain('Install')
    expect(error.details).toBe(
      'b10298-2.0.0/macos-arm64: probe failed: Timed out while probing llama.cpp backend capabilities. (llama-server -h did not finish within 30s)'
    )
  })

  it('does not call the engines unsupported while one of them could not be checked', async () => {
    const packs = [pack('b10400-2.1.0', 'cpu'), pack('b10269-1.6.0', 'cpu')]
    const r = new DecisionEngineResolver({
      layout: dataLayout(data.root),
      listPacks: async () => packs,
      mtime: async () => 1,
      probe: async (exe) => {
        if (exe === packs[0]!.path) throw new Error('spawn EBUSY')
        return false
      },
    })
    const error = await rejection<AtomicCoreError>(r.resolve())
    expect(error.code).toBe('MODEL_LOAD_FAILED')
    expect(error.details).toContain('b10400-2.1.0/cpu: probe failed: spawn EBUSY')
    expect(error.details).toContain(`b10269-1.6.0/cpu: ${DECISION_FLAG} is not in its -h output`)
  })

  it('runs a lower build that passes when a higher one could not be checked', async () => {
    const packs = [pack('b10400-2.1.0', 'cpu'), pack('b10300-2.0.0', 'cpu')]
    const r = new DecisionEngineResolver({
      layout: dataLayout(data.root),
      listPacks: async () => packs,
      mtime: async () => 1,
      probe: async (exe) => {
        if (exe === packs[0]!.path) throw new Error('timed out')
        return true
      },
    })
    expect((await r.resolve()).path).toBe(packs[1]!.path)
  })

  it('fails an explicit engine path whose probe could not run with the probe error', async () => {
    const r = new DecisionEngineResolver({
      layout: dataLayout(data.root),
      mtime: async () => 1,
      probe: async () => {
        throw new AtomicCoreError(
          'MODEL_LOAD_TIMED_OUT',
          'Timed out while probing llama.cpp backend capabilities.'
        )
      },
    })
    await expect(r.resolve('/opt/llama-server')).rejects.toMatchObject({
      code: 'MODEL_LOAD_TIMED_OUT',
      details: '/opt/llama-server: probe failed: Timed out while probing llama.cpp backend capabilities.',
    })
  })

  it('skips a build that readiness rejected until its file changes', async () => {
    let mtime = 1
    const packs = [pack('b10400-1.8.0', 'cpu'), pack('b10269-1.7.0', 'cpu')]
    const r = new DecisionEngineResolver({
      layout: dataLayout(data.root),
      listPacks: async () => packs,
      mtime: async (path) => (path === packs[0]!.path ? mtime : 1),
      probe: async () => true,
    })
    expect((await r.resolve()).path).toBe(packs[0]!.path)
    await r.reject(packs[0]!.path, 'api_version 2')
    expect((await r.resolve()).path).toBe(packs[1]!.path)
    await r.reject(packs[1]!.path, 'no decision capability')
    const error = await rejection<{ code: string; message: string; details: string }>(r.resolve())
    expect(error.code).toBe('DECISION_ENGINE_UNSUPPORTED')
    expect(error.details).toContain('b10400-1.8.0/cpu: refused at readiness: api_version 2')
    // The user already has builds that list --decision: no advice to install 1.7.0.
    expect(error.message).toContain('2 that list --decision were refused at readiness')
    expect(error.message).not.toContain('Install')
    // A replaced pack (an update) is tried again; a file that is gone is not remembered.
    mtime = 2
    expect((await r.resolve()).path).toBe(packs[0]!.path)
    await r.reject('/missing/llama-server', 'x')
  })

  it('tries every refused build again after forgetRejected', async () => {
    const probes: string[] = []
    const packs = [pack('b10400-1.8.0', 'cpu'), pack('b10000-1.6.0', 'cpu')]
    const r = resolver(packs, new Set([packs[0]!.path]), probes)
    await r.reject(packs[0]!.path, 'api_version 2')
    const error = await rejection<{ message: string; details: string }>(r.resolve())
    // One refused, one without the flag: the message names the refusal, the details both.
    expect(error.message).toContain('1 that lists --decision was refused at readiness')
    expect(error.details).toContain(`b10000-1.6.0/cpu: ${DECISION_FLAG} is not in its -h output`)
    r.forgetRejected()
    r.forgetRejected()
    expect((await r.resolve()).path).toBe(packs[0]!.path)
    // A refused build is skipped before its probe; forgotten, it is probed and runs.
    expect(probes).toEqual([packs[1]!.path, packs[0]!.path])
  })

  it('checks an explicit engine path with the same probe, and refuses a missing one', async () => {
    const r = new DecisionEngineResolver({
      layout: dataLayout(data.root),
      listPacks: async () => {
        throw new Error('an explicit engine must not scan')
      },
      mtime: async (path) => (path === '/opt/llama-server' ? 5 : undefined),
      probe: async () => true,
    })
    expect(await r.resolve('/opt/llama-server')).toEqual({
      path: '/opt/llama-server',
      version_backend: null,
      fork_version: null,
      version_gate: null,
      dialect: 'turboquant',
      provider: null,
    })
    await expect(r.resolve('/missing/llama-server')).rejects.toMatchObject({
      code: 'DECISION_ENGINE_UNSUPPORTED',
      details: '/missing/llama-server: no such file',
    })
  })

  it('scans the TurboQuant folder whatever the chat provider is, and probes the real -h output', async () => {
    const layout = dataLayout(data.root)
    const dir = join(layout.provider('llamacpp').backendsDir, 'b10269-1.7.0', 'macos-arm64', 'build', 'bin')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'llama-server'), '')
    const probeWith = (decision: boolean) => (exe: string) =>
      checkSpecTypeSupport(exe, DECISION_FLAG, {}, undefined, { spawn: fakeLlamaSpawnRaw({ decision }) })
    const found = await new DecisionEngineResolver({
      layout,
      platform: 'darwin',
      probe: probeWith(true),
    }).resolve()
    expect(found).toMatchObject({
      path: join(dir, 'llama-server'),
      version_backend: 'b10269-1.7.0/macos-arm64',
    })
    await expect(
      new DecisionEngineResolver({ layout, platform: 'darwin', probe: probeWith(false) }).resolve()
    ).rejects.toMatchObject({ code: 'DECISION_ENGINE_UNSUPPORTED' })
  })
})

describe('DecisionEngineResolver for upstream decision GGUFs', () => {
  const upstream = (packs: Record<string, InstalledEnginePack[]>, probes: string[] = []) =>
    new DecisionEngineResolver({
      layout: dataLayout(data.root),
      listPacks: async (provider) => packs[provider] ?? [],
      mtime: async () => 1,
      probe: async (exe) => {
        probes.push(exe)
        return true
      },
    })

  it('takes the newest stock build at the floor, without a -h probe', async () => {
    const probes: string[] = []
    const r = upstream(
      {
        'llamacpp-upstream': [pack('b11344', 'macos-arm64'), pack('b11436', 'macos-arm64')],
        'llamacpp': [pack('b10269-1.7.0', 'macos-arm64')],
      },
      probes
    )
    expect(await r.resolve('', { dialect: 'upstream', minBuild: 11418 })).toEqual({
      path: '/packs/b11436/macos-arm64/llama-server',
      version_backend: 'b11436/macos-arm64',
      fork_version: null,
      version_gate: true,
      dialect: 'upstream',
      provider: 'llamacpp-upstream',
    })
    expect(probes).toEqual([])
  })

  it('names the build to update to when every installed one is older', async () => {
    const r = upstream({ 'llamacpp-upstream': [pack('b11344', 'macos-arm64')] })
    const error = await rejection<AtomicCoreError>(r.resolve('', { dialect: 'upstream', minBuild: 11370 }))
    expect(error).toMatchObject({
      code: 'DECISION_ENGINE_UNSUPPORTED',
      message:
        'No installed llama.cpp build can run the decision model. Update llama.cpp to b11370 or newer.',
      details: 'b11344/macos-arm64: older than b11370',
    })
  })

  it('skips a build readiness refused, and says so when none is left', async () => {
    const r = upstream({
      'llamacpp-upstream': [pack('b11436', 'macos-arm64'), pack('b11400', 'macos-arm64')],
    })
    await r.reject('/packs/b11436/macos-arm64/llama-server', 'no decisions in /v1/models')
    expect((await r.resolve('', { dialect: 'upstream' })).version_backend).toBe('b11400/macos-arm64')
    await r.reject('/packs/b11400/macos-arm64/llama-server', 'no decisions in /v1/models')
    const error = await rejection<AtomicCoreError>(r.resolve('', { dialect: 'upstream' }))
    expect(error.message).toContain('every build at b11370 or newer was refused at readiness')
  })

  it('runs an explicit engine path for upstream as long as the file is there', async () => {
    const r = new DecisionEngineResolver({
      layout: dataLayout(data.root),
      listPacks: async () => {
        throw new Error('an explicit engine must not scan')
      },
      mtime: async (path) => (path === '/opt/llama-server' ? 5 : undefined),
      probe: async () => false,
    })
    expect(await r.resolve('/opt/llama-server', { dialect: 'upstream' })).toMatchObject({
      dialect: 'upstream',
      provider: null,
    })
  })
})
