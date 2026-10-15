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
import type { ContractRoute, ContractString } from '../helpers/llamacpp-engine-strings.js'
import {
  breaks,
  hasPath,
  judgeRoute,
  judgeStrings,
  stableLine,
  verdictOf,
} from '../helpers/llamacpp-observed.js'
import { LLAMA_READY_MARKERS } from '../../src/runtime/shared/process.js'
import { DEVICE_INIT_ERROR_MARKERS } from '../../src/runtime/llamacpp/runtime-device.js'

const contract = deriveLlamaEngineContract()
const DEVICE_SOURCE = 'src/runtime/llamacpp/runtime-device.ts'
const CASCADE_SOURCE = 'src/runtime/llamacpp/errors.ts'

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

describe('the strings and routes of the contract', () => {
  const read = (path: string) => readFileSync(path, 'utf8')
  const lastKey = (path: string) => path.split('.').at(-1)?.replace(/\[\]$/, '') ?? path

  it('names every entry once', () => {
    const ids = contract.strings.map((s) => s.id)
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([])
    const routes = contract.routes.map((r) => `${r.method} ${r.path}`)
    expect(routes.filter((r, i) => routes.indexOf(r) !== i)).toEqual([])
    for (const route of contract.routes) {
      const fields = (route.fields ?? []).map((f) => `${f.path}@${f.when ?? ''}`)
      expect(
        fields.filter((f, i) => fields.indexOf(f) !== i),
        route.path
      ).toEqual([])
    }
  })

  it('finds each text in the file it names, so editing a literal means editing the contract', () => {
    for (const entry of contract.strings) {
      if (entry.match === 'regex') expect(() => new RegExp(entry.text, 'i'), entry.id).not.toThrow()
      if (entry.source === null) continue
      expect(read(entry.source), `${entry.source} no longer holds ${entry.id}: ${entry.text}`).toContain(
        entry.text
      )
    }
    for (const route of contract.routes) {
      expect(read(route.source), `${route.source} no longer calls ${route.path}`).toContain(
        route.source_text ?? route.path
      )
      for (const f of route.fields ?? [])
        if (f.source !== null)
          expect(read(f.source), `${f.source} no longer reads ${route.path} ${f.path}`).toContain(
            lastKey(f.path)
          )
    }
  })

  it('says why core and upstream disagree wherever the probe expects not to see a string', () => {
    for (const entry of contract.strings)
      if (entry.live_expectation === 'not-observed') expect(entry.note, entry.id).toBeTruthy()
  })

  it('has an entry for every readiness marker', () => {
    const ready = contract.strings.filter((s) => s.id.startsWith('ready.')).map((s) => s.text)
    expect(ready).toEqual([...LLAMA_READY_MARKERS])
  })

  it('has an entry for every device-error marker', () => {
    const texts = new Set(contract.strings.filter((s) => s.source === DEVICE_SOURCE).map((s) => s.text))
    for (const marker of DEVICE_INIT_ERROR_MARKERS) expect(texts, marker).toContain(marker)
  })

  it('has an entry for every needle of the stderr cascade', () => {
    const text = read('src/runtime/llamacpp/errors.ts')
    const cascade = text.slice(text.indexOf('const CASCADE'), text.indexOf('GENERIC_PROCESS_ERROR_MESSAGE ='))
    const needles = new Set<string>()
    for (const [, list] of cascade.matchAll(/includesAny\(l, \[([\s\S]*?)\]\)/g))
      for (const [, needle] of (list ?? '').matchAll(/'([^']+)'/g)) needles.add(needle ?? '')
    for (const [, needle] of cascade.matchAll(/l\.includes\('([^']+)'\)/g)) needles.add(needle ?? '')
    const tensorCount = /const TENSOR_COUNT_MISMATCH = '([^']+)'/.exec(text)?.[1]
    if (tensorCount !== undefined) needles.add(tensorCount)
    expect(needles.size).toBeGreaterThan(15)
    const texts = new Set(contract.strings.filter((s) => s.source === CASCADE_SOURCE).map((s) => s.text))
    for (const needle of needles) expect(texts, needle).toContain(needle)
  })

  it('has an entry for every MTP rejection pattern and compute-error needle', () => {
    const mtp = read('src/models/gguf/classify.ts')
    const fn = mtp.slice(
      mtp.indexOf('export function matchesMtpLoadFailure'),
      mtp.indexOf('export function hasEmbeddedMtp')
    )
    const patterns = [...fn.matchAll(/\/(.+?)\/i\.test\(text\)/g)].map((m) => m[1])
    expect(patterns.length).toBeGreaterThan(0)
    const regexes = new Set(contract.strings.filter((s) => s.match === 'regex').map((s) => s.text))
    for (const pattern of patterns) expect(regexes, pattern).toContain(pattern)

    const errors = read('src/server/public/errors.ts')
    const compute = errors.slice(errors.indexOf('export function isComputeBackendError'))
    const needles = [...(/\[([\s\S]*?)\]\.some/.exec(compute)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(
      (m) => m[1]
    )
    expect(needles.length).toBeGreaterThan(0)
    const http = new Set(contract.strings.filter((s) => s.channel === 'http').map((s) => s.text))
    for (const needle of needles) expect(http, needle).toContain(needle)
  })
})

describe('judging what the live probe saw', () => {
  const entry = (over: Partial<ContractString>): ContractString => ({
    id: 'x',
    text: 'Listening On',
    match: 'substring-ci',
    channel: 'log',
    source: null,
    severity_if_lost: 'break',
    live_expectation: 'observed',
    ...over,
  })

  it.each([
    ['observed', true, 'as-expected'],
    ['observed', false, 'lost'],
    ['not-observed', false, 'as-expected'],
    ['not-observed', true, 'appeared'],
    ['conditional', true, 'recorded'],
    ['unobservable', false, 'recorded'],
    ['observed', null, 'not-checked'],
  ] as const)('%s, seen %s → %s', (expectation, seen, verdict) => {
    expect(verdictOf(expectation, seen)).toBe(verdict)
  })

  it('matches a substring in any case, a pattern with `i`, and keeps the evidence', () => {
    const [s, r] = judgeStrings(
      [entry({}), entry({ id: 'r', text: "doesn'?t contain MTP layers", match: 'regex' })],
      {
        log: [
          'srv  llama_server: listening on http://127.0.0.1:1',
          'the draft model doesnt contain mtp layers',
        ],
      }
    )
    expect(s).toMatchObject({
      seen: true,
      verdict: 'as-expected',
      evidence: 'srv  llama_server: listening on http://127.0.0.1:1',
    })
    expect(r).toMatchObject({ seen: true, verdict: 'as-expected' })
  })

  it('checks nothing on a channel the probe collected nothing on', () => {
    expect(judgeStrings([entry({ channel: 'list-devices' })], { log: ['x'] })[0]?.verdict).toBe('not-checked')
  })

  it('walks array paths in plain answers, stream events and the overflow error', () => {
    expect(hasPath({ choices: [{}, { message: { content: '' } }] }, 'choices[].message.content')).toBe(true)
    expect(hasPath({ choices: [] }, 'choices[].message.content')).toBe(false)
    expect(hasPath({ timings: null }, 'timings.prompt_n')).toBe(false)
    const route: ContractRoute = {
      id: 'chat',
      method: 'POST',
      path: '/v1/chat/completions',
      source: 'x',
      severity_if_lost: 'break',
      live_expectation: 'observed',
      fields: [
        {
          path: 'usage.prompt_tokens',
          source: null,
          severity_if_lost: 'break',
          live_expectation: 'observed',
        },
        {
          path: 'timings.predicted_n',
          when: 'stream',
          source: null,
          severity_if_lost: 'warn',
          live_expectation: 'observed',
        },
        {
          path: 'error.n_ctx',
          when: 'context-overflow',
          source: null,
          severity_if_lost: 'info',
          live_expectation: 'observed',
        },
      ],
    }
    const judged = judgeRoute(route, {
      status: 200,
      plain: {},
      stream: [{}, { timings: { predicted_n: 3 } }],
    })
    expect(judged.fields.map((f) => f.verdict)).toEqual(['lost', 'as-expected', 'not-checked'])
    expect(breaks([], [judged])).toEqual(['field /v1/chat/completions usage.prompt_tokens'])
    expect(judgeRoute(route, { status: 404 }).verdict).toBe('lost')
    expect(judgeRoute(route, undefined).verdict).toBe('not-checked')
    const gated: ContractRoute = {
      ...route,
      fields: [{ ...route.fields![0]!, min_build: 100 }],
    }
    expect(judgeRoute(gated, { status: 200, plain: {} }, 99).fields[0]?.verdict).toBe('not-checked')
    expect(judgeRoute(gated, { status: 200, plain: {} }, 100).fields[0]?.verdict).toBe('lost')
  })
})

describe('stableLine', () => {
  it.each([
    [
      '0.03.573.207 I srv  llama_server: listening on http://127.0.0.1:3418',
      'I srv  llama_server: listening on http://127.0.0.1:<port>',
    ],
    [
      'main: server is listening on http://0.0.0.0:8080 - starting',
      'main: server is listening on http://0.0.0.0:<port> - starting',
    ],
    ['  error: invalid argument: --x  ', 'error: invalid argument: --x'],
  ])('%s', (line, stable) => {
    expect(stableLine(line)).toBe(stable)
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
