/**
 * The upstream llama.cpp engine contract (test/fixtures/llamacpp/engine-contract.json) is what the
 * argv builders actually emit: regenerated here and compared to the committed file, so a builder
 * change lands together with the contract change a reviewer — or the update pipeline — can read.
 * Regenerate with `npx vitest run --project contract -u test/contract/llamacpp-engine-contract.test.ts`.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { getBackendArchiveName, parseManifestForPlatform } from '../../src/backend/index.js'
import {
  argsBuildGates,
  backendAssetPattern,
  deriveLlamaEngineContract,
  sampledBuilds,
  toRanges,
} from '../helpers/llamacpp-engine-contract.js'

const contract = deriveLlamaEngineContract()

describe('the upstream llama.cpp engine contract', () => {
  it('matches the committed file', async () => {
    await expect(`${JSON.stringify(contract, null, 2)}\n`).toMatchFileSnapshot(
      '../fixtures/llamacpp/engine-contract.json'
    )
  })

  it('shows every build gate of the chat argv builder as an edge', () => {
    const edges = new Set(
      contract.flags
        .flatMap((f) => [
          ...Object.values(f.emitters).flatMap((ranges) => ranges ?? []),
          ...(f.values ?? []).flatMap((v) => v.builds),
        ])
        .flatMap((r) => [r.from, r.until])
    )
    for (const gate of argsBuildGates())
      expect(edges.has(gate.build), `${gate.name} = ${gate.build} changes no flag or value`).toBe(true)
  })

  it('knows every flag literal in the three upstream argv builders', () => {
    const universe = new Set(contract.flags.map((f) => f.flag))
    const allowed: Record<string, string> = {
      '-fa': 'ik builds only, not upstream',
      '--decision': 'TurboQuant fork only (buildDecisionArgs)',
      '--decision-spec': 'TurboQuant fork only',
      '--decision-convert-cache': 'TurboQuant fork only',
      '--decision-convert-type': 'TurboQuant fork only',
      '--decision-allow-uncalibrated': 'TurboQuant fork only',
    }
    for (const source of ['src/runtime/llamacpp/args.ts', 'src/embedding/args.ts', 'src/decision/args.ts']) {
      const text = readFileSync(source, 'utf8')
      for (const [, flag] of text.matchAll(/'(--?[a-z][a-z0-9-]*)'/g)) {
        if (flag === undefined || universe.has(flag)) continue
        expect(allowed[flag], `${source} emits ${flag}, which the contract never sees`).toBeDefined()
      }
    }
  })

  it('records the flags of a removal exactly at its gate', () => {
    const flag = (name: string) => contract.flags.find((f) => f.flag === name)
    expect(flag('--no-mmap')?.emitters.chat).toEqual([{ from: null, until: 10875 }])
    expect(flag('--mlock')?.emitters.chat).toEqual([{ from: null, until: 10875 }])
    expect(flag('--load-mode')?.emitters.chat).toEqual([{ from: 10875, until: null }])
    expect(flag('--no-reasoning-preserve')?.emitters.chat).toEqual([{ from: 10762, until: null }])
    expect(flag('--spec-type')?.values?.find((v) => v.value === 'draft-dflash')?.probe_gated).toBe(true)
  })

  it('reads `-ngl -1` as a flag and its value, never `-1` as a flag', () => {
    expect(contract.flags.map((f) => f.flag)).toContain('-ngl')
    expect(contract.flags.every((f) => /^--?[A-Za-z]/.test(f.flag))).toBe(true)
  })
})

describe('the archives core installs (assets.core_backends)', () => {
  const release = (tag: string) =>
    JSON.parse(
      readFileSync(new URL(`../fixtures/llamacpp/releases/${tag}.json`, import.meta.url), 'utf8')
    ) as {
      tag: string
      assets: string[]
    }
  const matching = (tag: string, platform: string, assets: readonly string[]) =>
    contract.assets.core_backends
      .filter((b) => b.platform === platform)
      .flatMap((b) => assets.filter((n) => new RegExp(`^${b.asset.replace('{tag}', tag)}$`).test(n)))
      .sort()

  it.each(['b10874', 'b11463', 'b11617'])(
    '%s: the patterns pick exactly what the manifest parser offers each platform',
    (tag) => {
      const { assets } = release(tag)
      for (const [platform, os, arch] of [
        ['linux-x64', 'linux', 'x64'],
        ['linux-arm64', 'linux', 'arm64'],
        ['macos-x64', 'macos', 'x64'],
        ['macos-arm64', 'macos', 'arm64'],
        ['windows-x64', 'windows', 'x64'],
        ['windows-arm64', 'windows', 'arm64'],
      ] as const) {
        const offered = parseManifestForPlatform(
          { tag_name: tag, assets: assets.map((name) => ({ name })) },
          os,
          arch
        )
          .map((b) => getBackendArchiveName(tag, b.backend))
          .sort()
        expect(matching(tag, platform, assets), platform).toEqual(offered)
      }
    }
  )

  it('marks the one backend of each platform every host runs', () => {
    const cpu = contract.assets.core_backends.filter((b) => b.cpu).map((b) => b.backend)
    expect(cpu).toEqual([
      'linux-cpu-x64',
      'linux-cpu-arm64',
      'macos-x64',
      'macos-arm64',
      'win-cpu-x64',
      'win-cpu-arm64',
    ])
  })

  it('frees the toolkit minor of a GPU family, and only that', () => {
    expect(backendAssetPattern('win-cuda-13-x64')).toBe('llama-{tag}-bin-win-cuda-13\\.\\d+-x64\\.zip')
    expect(backendAssetPattern('win-rocm-x64')).toBe('llama-{tag}-bin-win-rocm-\\d+\\.\\d+-x64\\.zip')
    expect(backendAssetPattern('linux-cuda-13-arm64')).toBe(
      'llama-{tag}-bin-ubuntu-cuda-13\\.\\d+-arm64\\.tar\\.gz'
    )
    expect(backendAssetPattern('win-cuda-12.4-x64')).toBe('llama-{tag}-bin-win-cuda-12\\.4-x64\\.zip')
  })
})

describe('toRanges', () => {
  const builds = [1, 9, 10, 19, 20]
  it.each([
    [[1, 9, 10, 19, 20], [{ from: null, until: null }]],
    [[1, 9], [{ from: null, until: 10 }]],
    [[10, 19, 20], [{ from: 10, until: null }]],
    [[10, 19], [{ from: 10, until: 20 }]],
    [[], []],
  ])('%j → %j', (present, expected) => {
    expect(toRanges(new Set(present), builds)).toEqual(expected)
  })

  it('samples 1 and both sides of every gate', () => {
    const builds = sampledBuilds()
    expect(builds[0]).toBe(1)
    for (const gate of argsBuildGates())
      expect(builds).toEqual(expect.arrayContaining([gate.build - 1, gate.build]))
  })
})
