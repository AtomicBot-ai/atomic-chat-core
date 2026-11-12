/**
 * The MLX engine contract (test/fixtures/mlx/engine-contract.json) is written by hand, so each part is
 * held here to what it describes: the flags and their choices to `buildMlxServerArgs` and to the real
 * `mlx-server --help` of the pin and of v0.7.12, the install probe to `mlxProbePassed` and its timeout,
 * the archive layout to the binary the install runs, the env and the strings to the runtime and the
 * routes the public server forwards, and the archive to conf's manifests, the fork's releases and
 * `mlxHostChoice`. A change on either side fails here until the other follows.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  MLX_PROBE_TIMEOUT_MS,
  MLX_SERVER_BINARY,
  mlxHostChoice,
  mlxProbePassed,
  parseMlxManifest,
} from '../../src/engine-builds/index.js'
import { buildMlxServerArgs } from '../../src/runtime/mlx/args.js'
import { MLX_STDERR_READY_MARKERS, MLX_STDOUT_READY_MARKERS } from '../../src/runtime/mlx/errors.js'
import { MLX_MAX_TOKENS_ENV } from '../../src/runtime/mlx/runtime.js'
import type { MlxServerConfig } from '../../src/runtime/mlx/config.js'
import { checkMlxHelp, mlxBackendArchives, parseMlxHelp } from '../../scripts/lib/mlx-surface.mjs'
import type { MlxContract } from '../../scripts/lib/mlx-surface.mjs'

type Contract = MlxContract & {
  engine: string
  invocations: Array<{ bin: string; argv: string[]; source: string; severity: string }>
  probe: { argv: string[]; pattern: string; source: string }
  archive: { entries: string[]; source: string }
  env: Array<{ name: string; value?: string; source: string }>
  strings: Array<{
    id: string
    text: string
    channel: string
    upstream_text: string
    source: string
    severity_if_lost: string
  }>
  assets: {
    core_backends: Array<{
      platform: string
      backend: string
      cpu: boolean
      required: boolean
      asset: string
    }>
  }
  upstream: { repo: string; branch: string; watched_paths: Array<{ path: string; why: string }> }
}

const fixture = (path: string) => readFileSync(new URL(`../fixtures/mlx/${path}`, import.meta.url), 'utf8')
const contract = JSON.parse(fixture('engine-contract.json')) as Contract
const HELPS = {
  'mlxvlm-macos-arm64-07ba5a1': fixture('help/mlxvlm-macos-arm64-07ba5a1.txt'),
  'v0.7.12': fixture('help/v0.7.12.txt'),
}
const release = (tag: string) =>
  JSON.parse(fixture(`releases/${tag}.json`)) as { tag: string; assets: Array<{ name: string }> }

/** Every setting a load can carry that changes the argv: a drafter of `draft_kind`, KV quantization. */
const config = (over: Partial<MlxServerConfig> = {}): MlxServerConfig => ({
  ctx_size: 4096,
  draft_model_path: '/models/d',
  block_size: 16,
  draft_kind: 'dflash',
  kv_bits: 4,
  kv_quant_scheme: 'uniform',
  ...over,
})
const argv = (over: Partial<MlxServerConfig> = {}) =>
  buildMlxServerArgs('/models/m', 8080, config(over), () => false)
const valueOf = (args: string[], flag: string) =>
  args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined
const choicesOf = (flag: string) => contract.flags.find((f) => f.flag === flag)?.choices ?? []

describe('the MLX engine contract: flags and choices', () => {
  it('names exactly the flags buildMlxServerArgs can pass, each from args.ts', () => {
    const emitted = new Set(argv().filter((a) => a.startsWith('--')))
    expect(new Set(contract.flags.map((f) => f.flag))).toEqual(emitted)
    expect(contract.flags).toHaveLength(emitted.size)
    for (const f of contract.flags)
      expect([f.source, f.severity], f.flag).toEqual(['src/runtime/mlx/args.ts', 'break'])
    // Without a drafter or KV quantization only the model, the address and the window are passed.
    expect(
      buildMlxServerArgs('/models/m', 1, config({ draft_model_path: '', kv_bits: 0 }), () => false).filter(
        (a) => a.startsWith('--')
      )
    ).toEqual(['--model', '--host', '--port', '--max-kv-size'])
  })

  it('knows every flag literal of the argv builder', () => {
    const source = readFileSync('src/runtime/mlx/args.ts', 'utf8')
    const literals = [...source.matchAll(/'(--[A-Za-z][\w-]*)'/g)].map((m) => m[1] as string)
    expect(new Set(literals)).toEqual(new Set(contract.flags.map((f) => f.flag)))
  })

  it('lists every drafter kind the builder passes, and an unknown kind falls back to one of them', () => {
    for (const kind of choicesOf('--draft-kind'))
      expect(valueOf(argv({ draft_kind: kind }), '--draft-kind')).toBe(kind)
    expect(valueOf(argv({ draft_kind: 'medusa' }), '--draft-kind')).toBe('dflash')
    expect(choicesOf('--draft-kind')).toContain('dflash')
    expect([...choicesOf('--draft-kind')].sort()).toEqual(['dflash', 'eagle3', 'mtp'])
  })

  it('lists every KV scheme the builder passes, and no other scheme reaches the argv', () => {
    for (const scheme of choicesOf('--kv-quant-scheme'))
      expect(valueOf(argv({ kv_quant_scheme: scheme }), '--kv-quant-scheme')).toBe(scheme)
    expect(argv({ kv_quant_scheme: 'none' })).not.toContain('--kv-quant-scheme')
    expect([...choicesOf('--kv-quant-scheme')].sort()).toEqual(['turboquant', 'uniform'])
  })

  it.each(Object.keys(HELPS))('%s: --help lists every flag and choice, as whole tokens', (tag) => {
    const help = HELPS[tag as keyof typeof HELPS]
    expect(checkMlxHelp(contract, parseMlxHelp(help))).toEqual([])
    for (const { flag } of contract.flags)
      expect(help, flag).toMatch(new RegExp(`(^|[\\s[])${flag}(?![\\w-])`, 'm'))
  })
})

describe('the MLX engine contract: the install probe, the archive and the env', () => {
  it('runs the server by its name, --help, which has to exit 0: the probe reads it', () => {
    expect(contract.invocations).toMatchObject([
      { bin: MLX_SERVER_BINARY, argv: ['--help'], severity: 'break' },
    ])
    expect(contract.probe).toMatchObject({ argv: ['--help'], source: 'src/engine-builds/builds.ts' })
    expect(contract.invocation_timeout_ms).toBe(MLX_PROBE_TIMEOUT_MS)
  })

  it('reads the probe’s marker as mlxProbePassed does, on the real help screens and on others', () => {
    const marker = new RegExp(contract.probe.pattern, 'i')
    for (const text of [
      ...Object.values(HELPS),
      'Usage: MLX-SERVER [-h]',
      'usage: mlx-server-x',
      'usage: mlx_vlm.server',
      '',
    ])
      expect(marker.test(text), text.slice(0, 30)).toBe(mlxProbePassed(text, { code: 0, signal: null }))
    expect(mlxProbePassed(HELPS['v0.7.12'], { code: 2, signal: null })).toBe(false)
  })

  it('unpacks to the one binary the install runs', () => {
    expect(contract.archive.entries).toEqual([MLX_SERVER_BINARY])
    expect(readFileSync(contract.archive.source, 'utf8')).toContain('join(dir, MLX_SERVER_BINARY)')
  })

  it('names the env the runtime sets, and searches upstream for the one it does not patch in', () => {
    const runtime = readFileSync('src/runtime/mlx/runtime.ts', 'utf8')
    expect(contract.env.map((e) => e.name)).toEqual(['MLX_VLM_SINGLE_MODEL', MLX_MAX_TOKENS_ENV])
    expect(runtime).toContain(`env['MLX_VLM_SINGLE_MODEL'] = '1'`)
    for (const e of contract.env) expect(readFileSync(e.source, 'utf8'), e.name).toContain(e.name)
    expect(contract.strings.find((s) => s.channel === 'env')).toMatchObject({
      text: MLX_MAX_TOKENS_ENV,
      upstream_text: `"${MLX_MAX_TOKENS_ENV}"`,
    })
    // The fork's patch, not upstream's: searching for it would only ever say "in neither tree".
    expect(contract.strings.map((s) => s.text)).not.toContain('MLX_VLM_SINGLE_MODEL')
  })

  it('searches upstream for the routes the public server forwards to, as the quoted paths it registers', () => {
    const routes = contract.strings.filter((s) => s.channel === 'http-route')
    expect(routes.map((s) => s.text)).toEqual(['/v1/chat/completions', '/v1/responses'])
    for (const s of routes) {
      expect(s.upstream_text).toBe(`"${s.text}"`)
      expect(readFileSync(s.source as string, 'utf8'), s.id).toContain(s.text.replace(/^\/v1/, ''))
    }
    expect(readFileSync('src/server/public/responses.ts', 'utf8')).toContain("session.provider === 'mlx'")
  })

  it('leaves readiness to the live tests: uvicorn prints it, no mlx-vlm source does', () => {
    expect(MLX_STDOUT_READY_MARKERS).toContain('uvicorn running on')
    expect(MLX_STDERR_READY_MARKERS).toContain('application startup complete')
    for (const marker of [...MLX_STDOUT_READY_MARKERS, ...MLX_STDERR_READY_MARKERS])
      expect(contract.strings.map((s) => s.text.toLowerCase())).not.toContain(marker)
  })
})

describe('the MLX engine contract: the archive and upstream', () => {
  const [backend] = contract.assets.core_backends

  it('has one archive, the Apple Silicon build mlxHostChoice picks, whatever the tag', () => {
    expect(contract.assets.core_backends).toHaveLength(1)
    expect(backend).toMatchObject({
      platform: 'macos-arm64',
      backend: 'macos-arm64',
      cpu: true,
      required: true,
    })
    const manifest = { assets: [{ backend: backend?.backend as string }] }
    expect(mlxHostChoice({ os: 'macos', arch: 'arm64' }, manifest).backend_id).toBe(backend?.backend)
    for (const host of [
      { os: 'macos', arch: 'x64' },
      { os: 'linux', arch: 'arm64' },
      { os: 'windows', arch: 'x64' },
    ])
      expect(mlxHostChoice(host, manifest).backend_id, `${host.os}-${host.arch}`).toBeNull()
  })

  it.each(['v0.7.12', 'mlxvlm-macos-arm64-07ba5a1', 'mlxvlm-macos-arm64-1f48deb'])(
    '%s: the archive is taken, requirements.lock.txt is not',
    (tag) => {
      const names = release(tag).assets.map((a) => a.name)
      expect(mlxBackendArchives(contract, tag, names)).toEqual({
        'macos-arm64': ['mlxvlm-mlx-server-macos-arm64.tar.gz'],
      })
    }
  )

  it('takes the archive conf’s manifests name, under the backend id they give it', () => {
    for (const name of ['mlx-manifest.json', 'mlx-manifest.staging.json']) {
      const doc = parseMlxManifest(JSON.parse(fixture(`conf/${name}`)))
      const archives = mlxBackendArchives(
        contract,
        doc.tag_name,
        doc.assets.map((a) => a.name)
      )
      expect(doc.assets.map((a) => [a.backend, a.name])).toEqual(
        Object.entries(archives).map(([id, names]) => [id, names[0]])
      )
    }
  })

  it('watches the server folder of Neywa-Labs/mlx-vlm, and what the build bundles', () => {
    expect(contract.upstream).toMatchObject({ repo: 'Neywa-Labs/mlx-vlm', branch: 'main' })
    expect(contract.upstream.watched_paths.map((w) => w.path)).toEqual([
      'mlx_vlm/server/',
      'mlx_vlm/version.py',
      'requirements.txt',
      'pyproject.toml',
    ])
  })
})
