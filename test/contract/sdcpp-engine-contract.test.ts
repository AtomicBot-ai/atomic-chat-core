/**
 * The stable-diffusion.cpp engine contract (test/fixtures/sdcpp/engine-contract.json) is written by
 * hand, so each part is held here to the code it describes: the flags to `buildServerArgs` and
 * required-flags.txt, the invocations and markers to the install probe, the routes to the HTTP
 * client's paths, the strings to the output parsers, and the archives to conf's release names and
 * the backend ladder of src/engine-builds/select.ts. A change on either side fails here until the
 * other follows.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CAPABILITIES_PATH,
  classifyExit,
  cliBinaryName,
  GpuFaultWatch,
  IMG_GEN_PATH,
  isGgmlUnsupportedOpAbort,
  isProgressRedraw,
  JOBS_PATH,
  parseStepLine,
  parseTileAnnouncement,
  probeOutputIsSdcpp,
  READY_PATH,
  serverBinaryName,
  VID_GEN_PATH,
} from '../../src/diffusion/index.js'
import { diffusionBackendLadder } from '../../src/engine-builds/index.js'
import type { DiffusionBackendSelectionInput } from '../../src/engine-builds/index.js'
import { parseSdVersion, sdcppBackendArchives } from '../../scripts/lib/sdcpp-surface.mjs'
import type { SdcppContract } from '../../scripts/lib/sdcpp-surface.mjs'

interface Contract {
  engine: string
  invocations: Array<{ bin: string; argv: string[]; source: string; severity: string; optional?: boolean }>
  probe: { bins: string[]; argv: string[]; markers: string[] }
  version: { pattern: string }
  flags: Array<{ flag: string; severity: string; source: string }>
  strings: Array<{ id: string; text: string; channel: string; upstream_text: string | null }>
  assets: {
    core_backends: Array<{
      platform: string
      backend: string
      cpu: boolean
      required: boolean
      companion?: boolean
      asset: string
    }>
  }
  upstream: { repo: string; watched_paths: Array<{ path: string }> }
}

const fixture = (path: string) => readFileSync(new URL(`../fixtures/sdcpp/${path}`, import.meta.url), 'utf8')
const contract = JSON.parse(fixture('engine-contract.json')) as Contract & SdcppContract
const release = (tag: string) =>
  JSON.parse(fixture(`releases/${tag}.json`)) as { tag: string; assets: Array<{ name: string }> }

describe('the sd.cpp engine contract: flags', () => {
  const requiredFlags = fixture('required-flags.txt')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))

  it('breaks on exactly the flags of required-flags.txt and their -v, and only warns about -M', () => {
    const breaks = contract.flags.filter((f) => f.severity === 'break').map((f) => f.flag)
    expect(new Set(breaks)).toEqual(new Set([...requiredFlags, '-v']))
    expect(breaks).toHaveLength(requiredFlags.length + 1)
    expect(contract.flags.filter((f) => f.severity !== 'break')).toEqual([
      expect.objectContaining({ flag: '-M', severity: 'warn' }),
    ])
  })

  it('knows every flag literal of the argv builder', () => {
    const source = readFileSync('src/diffusion/args.ts', 'utf8')
    const universe = new Set(contract.flags.map((f) => f.flag))
    const literals = [...source.matchAll(/'(--?[A-Za-z][\w-]*)'/g)].map((m) => m[1] as string)
    // commandSummaryForLog reads these from an argv someone else built; buildServerArgs never emits them.
    const readOnly = new Set(['--width', '--height', '--steps', '--seed'])
    expect(literals.length).toBeGreaterThan(20)
    expect(literals.filter((flag) => !universe.has(flag) && !readOnly.has(flag))).toEqual([])
  })
})

describe('the sd.cpp engine contract: invocations and the install probe', () => {
  it('runs the binaries the install probe looks for, by their names on a POSIX host', () => {
    expect(contract.probe.bins).toEqual([cliBinaryName('linux'), serverBinaryName('linux')])
    expect(contract.invocations.map((i) => `${i.bin} ${i.argv.join(' ')}`)).toEqual([
      'sd-server --help',
      'sd-server --version',
      'sd-cli --help',
    ])
    // The probe reads markers, never the exit code: no invocation may fail the check on its exit.
    expect(contract.invocations.every((i) => i.severity === 'warn')).toBe(true)
    expect(contract.invocations.find((i) => i.bin === 'sd-cli')?.optional).toBe(true)
  })

  it('names markers each of which alone passes the probe, as the real help screens hold them', () => {
    for (const marker of contract.probe.markers)
      expect(probeOutputIsSdcpp(`x ${marker} y`), marker).toBe(true)
    expect(probeOutputIsSdcpp('usage: llama-server [options]')).toBe(false)
    for (const bin of ['sd-server', 'sd-cli']) {
      const help = fixture(`help/${bin}-master-883-137f740.txt`)
      expect(probeOutputIsSdcpp(help), bin).toBe(true)
    }
  })

  it('reads the version line the fork’s builds print', () => {
    expect(parseSdVersion(contract, fixture('help/sd-server-version-master-883-137f740.txt'))).toEqual({
      version: 'unknown',
      commit: '137f740',
    })
    expect(
      parseSdVersion(contract, 'stable-diffusion.cpp version master-975-95b3090, commit 95b3090')
    ).toEqual({ version: 'master-975-95b3090', commit: '95b3090' })
  })
})

describe('the sd.cpp engine contract: routes and strings', () => {
  const byId = (id: string) => contract.strings.find((s) => s.id === id)

  it('names the routes the HTTP client calls', () => {
    const routes = Object.fromEntries(
      contract.strings.filter((s) => s.channel === 'http-route').map((s) => [s.id, s.text])
    )
    expect(routes).toEqual({
      'route.ready': READY_PATH,
      'route.capabilities': CAPABILITIES_PATH,
      'route.img_gen': IMG_GEN_PATH,
      'route.vid_gen': VID_GEN_PATH,
      'route.job': `${JOBS_PATH}/{id}`,
      'route.cancel': `${JOBS_PATH}/{id}/cancel`,
    })
  })

  it('lists the progress text the parsers read', () => {
    expect(isProgressRedraw(`|====>   | 3/9 - 1.20${byId('progress.rate.s-it')?.text}`)).toBe(true)
    expect(isProgressRedraw(`|====>   | 3/9 - 1.20${byId('progress.rate.it-s')?.text}`)).toBe(true)
    expect(isProgressRedraw(`|====>   | 3/9 - 637.50M${byId('progress.rate.bytes')?.text}`)).toBe(true)
    expect(parseStepLine('|====>   | 12/28 - 3.52s/it')).toEqual([12, 28])
    expect(parseTileAnnouncement(byId('progress.tiles')?.text.replace('<N>', '9') ?? '')).toBe(9)
  })

  it('lists every out-of-memory text classifyExit reads, and only those', () => {
    const oom = contract.strings.filter((s) => s.id.startsWith('oom.'))
    expect(oom.length).toBe(7)
    for (const s of oom) expect(classifyExit(`... ${s.text} ...`, 1), s.id).toBe('OUT_OF_MEMORY')
    expect(classifyExit('segmentation fault', 139)).toBe('ENGINE_CRASHED')
  })

  it('lists the abort signature and the GPU faults the recovery and the watch read', () => {
    const text = (prefix: string) =>
      contract.strings
        .filter((s) => s.id.startsWith(prefix))
        .map((s) => s.text)
        .join('\n')
    expect(isGgmlUnsupportedOpAbort(text('abort.'))).toBe(true)
    for (const id of ['gpu-fault.address', 'gpu-fault.error-state']) {
      const watch = new GpuFaultWatch()
      watch.onLine(byId(id)?.text ?? '')
      expect(watch.tripped, id).toBe(true)
    }
    const watch = new GpuFaultWatch()
    for (const id of ['gpu-fault.command-buffer', 'gpu-fault.pagefault']) watch.onLine(byId(id)?.text ?? '')
    expect(watch.tripped).toBe(true)
  })

  it('searches leejet’s sources only for sd.cpp’s own text, in files it watches', () => {
    const own = contract.strings.filter((s) => s.upstream_text !== null).map((s) => s.id)
    expect(own.every((id) => /^(route|progress|oom\.model-manager)/.test(id))).toBe(true)
    const watched = contract.upstream.watched_paths.map((w) => w.path)
    for (const path of [
      'examples/server/routes_sdcpp.cpp',
      'examples/server/routes_openai.cpp',
      'src/core/util.cpp',
      'src/runtime/tiling.cpp',
      'src/pipeline/image.cpp',
      'src/model_manager.cpp',
    ])
      expect(watched).toContain(path)
  })
})

describe('the sd.cpp engine contract: archives', () => {
  const backends = contract.assets.core_backends

  it.each(['master-883-137f740', 'master-883-137f740-a36f1b1a'])(
    '%s: each backend takes exactly one archive of the release',
    (tag) => {
      const archives = sdcppBackendArchives(
        contract,
        tag,
        release(tag).assets.map((a) => a.name)
      )
      for (const b of backends) expect(archives[b.backend], b.backend).toHaveLength(1)
    }
  )

  it('lists every backend the host ladder can pick from a release, and nothing it never picks', () => {
    const available = backends.map((b) => b.backend)
    const hosts: Array<Omit<DiffusionBackendSelectionInput, 'available'>> = []
    for (const os of ['macos', 'windows', 'linux'] as const)
      for (const arch of ['arm64', 'x64'] as const)
        for (const features of [{}, { cuda12: true, cuda13: true, vulkan: true, rocm: true }])
          hosts.push({ os, arch, features, gpus: [{ totalMemoryMib: 8192 }] })
    const picked = new Set(hosts.flatMap((host) => diffusionBackendLadder({ ...host, available })))
    const companions = backends.filter((b) => b.companion).map((b) => b.backend)
    expect([...picked, ...companions].sort()).toEqual([...available].sort())
  })

  it('marks one CPU archive per platform, the bottom of its ladder', () => {
    const cpu = backends.filter((b) => b.cpu)
    expect(cpu.map((b) => b.platform).sort()).toEqual([
      'linux-arm64',
      'linux-x64',
      'macos-arm64',
      'windows-arm64',
      'windows-x64',
    ])
    for (const b of cpu) {
      const [os, arch] = b.platform.split('-') as ['macos' | 'windows' | 'linux', 'arm64' | 'x64']
      const ladder = diffusionBackendLadder({
        os,
        arch,
        features: {},
        gpus: [],
        available: backends.map((x) => x.backend),
      })
      expect(ladder.at(-1), b.platform).toBe(b.backend)
    }
  })
})
