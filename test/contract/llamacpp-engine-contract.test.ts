/**
 * The upstream llama.cpp engine contract (test/fixtures/llamacpp/engine-contract.json) is what the
 * argv builders actually emit: regenerated here and compared to the committed file, so a builder
 * change lands together with the contract change a reviewer — or the update pipeline — can read.
 * Regenerate with `npx vitest run --project contract -u test/contract/llamacpp-engine-contract.test.ts`.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  argsBuildGates,
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
