/**
 * The audio.cpp engine contract (test/fixtures/audiocpp/engine-contract.json) is written by hand, so
 * each part is held here to what it describes: every flag core passes and every route it calls to
 * the real `audiocpp_server --help` of v0.9.3 (its usage block, option lines and endpoint list), the
 * routes to the upstream strings searched for them, the probe and version patterns to the install
 * probe's parser and the real `--version`, and the archives to conf's release names (upstream's and
 * the fork's) and the backend ladder of src/engine-builds/select.ts. A change on either side fails
 * here until the other follows.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { audioServerBinaryName, parseAudioDevices, parseAudioVersion } from '../../src/audio/index.js'
import {
  audioBackendKindOf,
  audiocppHostChoice,
  diffusionBackendLadder,
} from '../../src/engine-builds/index.js'
import type { DiffusionBackendSelectionInput } from '../../src/engine-builds/index.js'
import {
  audiocppBackendArchives,
  parseAudioHelp,
  parseAudioVersionOutput,
} from '../../scripts/lib/audiocpp-surface.mjs'
import type { AudiocppContract } from '../../scripts/lib/audiocpp-surface.mjs'

type Contract = AudiocppContract & {
  engine: string
  invocations: Array<{ bin: string; argv: string[]; source: string; severity: string }>
  probe: { argv: string[]; marker: string }
  version: { pattern: string; commit_pattern: string }
  flags: Array<{ flag: string; severity: string; source: string }>
  routes: Array<{ method: string; path: string; source: string; severity: 'break' }>
  strings: Array<{ id: string; text: string; channel: string; upstream_text: string | null; source: string }>
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
  upstream: { repo: string; branch: string; watched_paths: Array<{ path: string; why: string }> }
}

const fixture = (path: string) =>
  readFileSync(new URL(`../fixtures/audiocpp/${path}`, import.meta.url), 'utf8')
const contract = JSON.parse(fixture('engine-contract.json')) as Contract
const HELP = fixture('v0.9.3/help.txt')
const VERSION = fixture('v0.9.3/version-macos-arm64.txt')
const release = (tag: string) =>
  JSON.parse(fixture(`releases/${tag}.json`)) as { tag: string; assets: Array<{ name: string }> }
const manifest = (name: string) =>
  JSON.parse(fixture(`conf/${name}`)) as {
    tag_name: string
    assets: Array<{ backend: string; name: string; companion?: boolean }>
  }

describe('the audio.cpp engine contract: flags and routes', () => {
  const help = parseAudioHelp(HELP)

  it('names only flags the v0.9.3 help screen lists, each as a whole token', () => {
    expect(contract.flags.map((f) => f.flag)).toEqual([
      '--config',
      '--no-ui',
      '--host',
      '--port',
      '--backend',
      '--threads',
      '--log',
      '--load-progress',
    ])
    for (const { flag } of contract.flags) {
      expect(help.flags, flag).toContain(flag)
      expect(HELP, flag).toMatch(new RegExp(`(^|[\\s[])${flag}(?![\\w-])`, 'm'))
    }
    // Every flag core passes would stop the launch if it were gone.
    expect(contract.flags.every((f) => f.severity === 'break')).toBe(true)
  })

  it('names only routes the v0.9.3 help screen lists under Endpoints, with their methods', () => {
    const listed = help.routes.map((r) => `${r.method} ${r.path}`)
    expect(contract.routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /health',
      'GET /v1/models',
      'POST /v1/audio/speech',
      'POST /v1/tasks/run',
      'GET /v1/audio/voices',
    ])
    for (const r of contract.routes) {
      expect(listed, `${r.method} ${r.path}`).toContain(`${r.method} ${r.path}`)
      const endpoints = HELP.slice(HELP.indexOf('Endpoints:'))
      expect(endpoints).toMatch(
        new RegExp(`^\\s+${r.method}\\s+${r.path.replace(/\//g, '\\/')}(\\?|\\s|$)`, 'm')
      )
    }
  })

  it('searches 0xShug0’s sources for exactly the routes, as the quoted paths the dispatcher compares', () => {
    const routes = contract.strings.filter((s) => s.channel === 'http-route')
    expect(routes).toHaveLength(contract.strings.length)
    expect(routes.map((s) => s.text).sort()).toEqual(contract.routes.map((r) => r.path).sort())
    for (const s of routes) {
      expect(s.upstream_text).toBe(`"${s.text}"`)
      expect(s.source).toBe(contract.routes.find((r) => r.path === s.text)?.source)
    }
    const watched = contract.upstream.watched_paths.map((w) => w.path)
    for (const path of ['app/server/main.cpp', 'app/server/request_dispatch.h', 'CMakeLists.txt'])
      expect(watched).toContain(path)
    expect(contract.upstream).toMatchObject({ repo: '0xShug0/audio.cpp', branch: 'main' })
  })
})

describe('the audio.cpp engine contract: invocations, the install probe and --version', () => {
  it('runs the server by its name on a POSIX host: --help, and the probe’s --version and --list-devices', () => {
    expect(contract.invocations.map((i) => `${i.bin} ${i.argv.join(' ')}`)).toEqual([
      `${audioServerBinaryName('linux')} --help`,
      `${audioServerBinaryName('linux')} --version`,
      `${audioServerBinaryName('linux')} --list-devices`,
    ])
    // The probe reads output, never the exit code: no invocation may fail the check on its exit.
    expect(contract.invocations.every((i) => i.severity === 'warn')).toBe(true)
    expect(contract.probe.argv).toEqual(['--version'])
  })

  it('names the marker the install probe reads, as the real --version prints it', () => {
    expect(VERSION.startsWith(contract.probe.marker)).toBe(true)
    expect(parseAudioVersion(`${contract.probe.marker}1.2.3\n`)).toMatchObject({ version: '1.2.3' })
    expect(parseAudioVersion('llama.cpp version 1 (abc)')).toBeNull()
    expect(parseAudioVersion(VERSION)).toEqual({ version: '0.9.3', backends: ['cpu', 'metal'] })
  })

  it('reads the version and the commit v0.9.3 prints, the one the install probe reads', () => {
    expect(parseAudioVersionOutput(contract, VERSION)).toEqual({ version: '0.9.3', commit: '41c1f8ff' })
    expect(parseAudioVersionOutput(contract, VERSION)?.version).toBe(parseAudioVersion(VERSION)?.version)
    expect(parseAudioVersionOutput(contract, 'audio.cpp dev\ngit: unknown unknown\n')).toEqual({
      version: 'dev',
      commit: 'unknown',
    })
  })

  it('lists devices as the probe of a GPU build reads them', () => {
    const devices = parseAudioDevices(fixture('v0.9.3/list-devices-macos-arm64.txt'))
    expect(devices.filter((d) => d.type === 'GPU').map((d) => d.registry)).toEqual(['MTL'])
  })
})

describe('the audio.cpp engine contract: archives', () => {
  const backends = contract.assets.core_backends

  it.each(['v0.9.3', 'v0.9.3-a1b2c3d4'])(
    '%s: each backend takes at most one archive of the release',
    (tag) => {
      const archives = audiocppBackendArchives(
        contract,
        tag,
        release(tag).assets.map((a) => a.name)
      )
      for (const b of backends) expect(archives[b.backend]?.length ?? 0, b.backend).toBeLessThanOrEqual(1)
    }
  )

  it('takes every archive conf’s manifests map, under the backend id they give it', () => {
    for (const name of ['audiocpp-manifest.staging.json', 'audiocpp-manifest.json']) {
      const doc = manifest(name)
      const archives = audiocppBackendArchives(
        contract,
        doc.tag_name,
        doc.assets.map((a) => a.name)
      )
      for (const asset of doc.assets.filter((a) => a.backend in archives))
        expect(archives[asset.backend], `${name}: ${asset.name}`).toEqual([asset.name])
      // A backend conf's mirror requires is in every manifest; the fork-only ones only in the fork's.
      for (const b of backends.filter((x) => x.required))
        expect(
          doc.assets.map((a) => a.backend),
          `${name}: ${b.backend}`
        ).toContain(b.backend)
    }
    // The fork builds every backend core installs, and one more the ladder never picks.
    const fork = manifest('audiocpp-manifest.json').assets.map((a) => a.backend)
    expect(fork.filter((id) => !backends.some((b) => b.backend === id))).toEqual(['win-cuda13-x64'])
    expect(backends.map((b) => b.backend).filter((id) => !fork.includes(id))).toEqual([])
  })

  it('marks the cudart archive as the companion conf’s manifests mark', () => {
    expect(backends.filter((b) => b.companion).map((b) => b.backend)).toEqual(['win-cudart-cu12'])
    for (const name of ['audiocpp-manifest.staging.json', 'audiocpp-manifest.json'])
      expect(
        manifest(name)
          .assets.filter((a) => a.companion)
          .map((a) => a.backend)
      ).toEqual(['win-cudart-cu12'])
  })

  it('lists every backend the host ladder can pick from a release, and nothing it never picks', () => {
    const doc = {
      tag_name: 'v0.9.3',
      assets: backends.map((b) => ({ backend: b.backend, ...(b.companion ? { companion: true } : {}) })),
    }
    const hosts: Array<Omit<DiffusionBackendSelectionInput, 'available'>> = []
    for (const os of ['macos', 'windows', 'linux'] as const)
      for (const arch of ['arm64', 'x64'] as const)
        for (const features of [{}, { cuda12: true, cuda13: true, vulkan: true, rocm: true }])
          hosts.push({ os, arch, features, gpus: [{ totalMemoryMib: 8192 }] })
    const picked = new Set(hosts.flatMap((host) => audiocppHostChoice(host, doc, new Set()).ladder))
    const companions = backends.filter((b) => b.companion).map((b) => b.backend)
    expect([...picked, ...companions].sort()).toEqual(backends.map((b) => b.backend).sort())
    for (const b of backends) expect(audioBackendKindOf(b.backend) === null, b.backend).toBe(!!b.companion)
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
        available: backends.filter((x) => !x.companion).map((x) => x.backend),
      })
      expect(ladder.at(-1), b.platform).toBe(b.backend)
    }
  })
})
