import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { SystemInfo } from '../../contracts/index.js'
import { osTypeOf, rustArch } from '../../hardware/index.js'
import { AtomicCore } from '../../core/index.js'
import { recordingIo } from '../io.js'
import { backendsCommand, formatCatalog, formatRecommendation, formatUpdates } from './backends.js'

let data: TmpDataFolder
const cores: AtomicCore[] = []

beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-cli-backends-')
})
afterEach(async () => {
  await Promise.all(cores.splice(0).map((c) => c.shutdown()))
  await data.cleanup()
})

const io = () => recordingIo()
const folder = () => ['--data-folder', data.root]
const hostBackend =
  process.platform === 'win32'
    ? 'win-cpu-x64'
    : process.platform === 'linux'
      ? 'linux-cpu-x64'
      : `macos-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
const archiveName = `llama-b99999-bin-${hostBackend === 'linux-cpu-x64' ? 'ubuntu-x64' : hostBackend}.${
  process.platform === 'win32' ? 'zip' : 'tar.gz'
}`

/** A core whose manifest comes from this fake fetch and whose hardware is a canned CPU-only host. */
async function createCore(): Promise<AtomicCore> {
  const info: SystemInfo = {
    cpu: {
      name: 'Fake CPU',
      core_count: 8,
      arch: rustArch(process.arch),
      extensions: ['avx', 'avx2'],
      extensions_known: true,
    },
    os_type: osTypeOf(process.platform),
    os_name: 'Fake OS',
    total_memory: 32_768,
    gpus: [],
  }
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.endsWith('/backends/manifest.json'))
      return new Response(JSON.stringify({ tag_name: 'b99999', assets: [{ name: archiveName }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    return new Response('not here', { status: 404 })
  }
  const core = await AtomicCore.create({
    dataFolder: data.root,
    controlPort: 0,
    fetch: fakeFetch,
    hardware: { probe: async () => ({ info, warnings: [] }) },
  })
  cores.push(core)
  return core
}

describe('backends', () => {
  it('lists what fits this machine and marks the recommended build', async () => {
    await createCore()
    const out = io()
    expect(await backendsCommand(['list', ...folder()], out)).toBe(0)
    const text = out.out.join('')
    expect(text).toContain('VERSION')
    expect(text).toContain(`b99999   ${hostBackend}`.slice(0, 12))
    expect(text).toContain('recommended')
    expect(text).toContain(`Recommended b99999/${hostBackend}`)
    expect(text).toContain('Source      live')
  })

  it('prints the catalog as JSON with --json and --current', async () => {
    await createCore()
    const out = io()
    expect(
      await backendsCommand(['list', '--json', '--current', `b1/${hostBackend}`, ...folder()], out)
    ).toBe(0)
    const parsed = JSON.parse(out.out.join('')) as {
      provider: string
      available: unknown[]
      recommended: string
    }
    expect(parsed.provider).toBe('llamacpp-upstream')
    expect(parsed.recommended).toBe(`b99999/${hostBackend}`)
    expect(parsed.available).toHaveLength(1)
  })

  it('recommends and checks updates through the same core', async () => {
    await createCore()
    const recommend = io()
    expect(
      await backendsCommand(['recommend', '--current', `b1/${hostBackend}`, ...folder()], recommend)
    ).toBe(0)
    const text = recommend.out.join('')
    if (process.platform === 'darwin') expect(text).toContain('single Metal build')
    else expect(text).toContain('CPU build is the best')

    const updates = io()
    expect(
      await backendsCommand(['updates', '--current', `b1/${hostBackend}`, '--json', ...folder()], updates)
    ).toBe(0)
    expect(JSON.parse(updates.out.join(''))).toMatchObject({
      update_needed: true,
      target_backend: `b99999/${hostBackend}`,
      same_family: true,
    })
  })

  it('rejects an unknown subcommand, provider or mode with exit 2', async () => {
    const bad = io()
    expect(await backendsCommand(['nope', ...folder()], bad)).toBe(2)
    expect(bad.err.join('')).toContain('Unknown backends subcommand')
    const provider = io()
    expect(await backendsCommand(['list', '--provider', 'mlx', ...folder()], provider)).toBe(2)
    expect(provider.err.join('')).toContain('llamacpp-upstream or llamacpp')
    const mode = io()
    expect(await backendsCommand(['recommend', '--mode', 'now', ...folder()], mode)).toBe(2)
    expect(mode.err.join('')).toContain('refresh or recheck')
  })
})

describe('formatters', () => {
  it('describe every recommendation outcome and update verdict', () => {
    const base = {
      provider: 'llamacpp-upstream' as const,
      mode: 'recheck' as const,
      detection: null,
      record: null,
      revision: 3,
      optimal: null,
      recommendation: null,
      elapsed_ms: 12,
    }
    expect(formatRecommendation({ ...base, outcome: 'mac' })).toContain('Metal')
    expect(formatRecommendation({ ...base, outcome: 'detection_failed' })).toContain('could not complete')
    expect(formatRecommendation({ ...base, outcome: 'no_catalog_entry' })).toContain('no release')
    expect(
      formatRecommendation({
        ...base,
        outcome: 'already_optimal',
        record: {
          schemaVersion: 1,
          provider: 'llamacpp-upstream',
          detectedAt: 1,
          detectionKind: 'cpu-optimal',
          currentBackend: 'b1/win-cpu-x64',
          recommendedCategory: 'CPU',
        },
      })
    ).toContain('(b1/win-cpu-x64)')
    expect(
      formatRecommendation({
        ...base,
        outcome: 'recommend',
        detection: { kind: 'gpu', backend: 'win-cuda-13.3-x64' },
        recommendation: {
          currentBackend: 'b1/win-cpu-x64',
          recommendedBackend: 'b2/win-cuda-13.3-x64',
          recommendedCategory: 'CUDA 13',
          provider: 'llamacpp-upstream',
          version: 'b2',
          backendId: 'win-cuda-13.3-x64',
        },
      })
    ).toContain('Recommended b2/win-cuda-13.3-x64 (CUDA 13)')

    const update = {
      provider: 'llamacpp-upstream' as const,
      current: 'b1/win-cuda-12.4-x64',
      current_kind: 'concrete' as const,
      update_needed: true,
      new_version: 'b2',
      target_backend: 'b2/win-cuda-13.3-x64',
      same_family: false,
      offer: null,
    }
    expect(formatUpdates(update)).toContain('different family')
    expect(formatUpdates({ ...update, same_family: true })).toContain('-> b2/win-cuda-13.3-x64 (same family)')
    expect(formatUpdates({ ...update, update_needed: false })).toContain('Up to date')
    expect(formatUpdates({ ...update, current_kind: 'missing' })).toContain('No backend is configured')

    const empty = formatCatalog({
      provider: 'llamacpp',
      os_type: 'linux',
      arch_suffix: 'x64',
      hardware_source: 'probe',
      features: {
        avx: true,
        avx2: true,
        avx512: false,
        cuda11: false,
        cuda12: false,
        cuda13: false,
        vulkan: false,
        rocm: false,
      },
      supported_backends: [],
      remote: [],
      installed: [],
      available: [],
      recommended: null,
      recommended_installed: null,
      latest_by_type: {},
      static_variants: [],
      source: 'none',
    })
    expect(empty).toContain('No backend of llamacpp fits this machine (source: none)')
  })
})
