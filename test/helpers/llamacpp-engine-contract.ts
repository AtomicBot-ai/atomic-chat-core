/**
 * The engine contract of upstream llama.cpp: every flag (and closed value) core can put on a
 * `llama-server` command line, and from which build to which, derived from the argv builders
 * themselves rather than written by hand. `test/contract/llamacpp-engine-contract.test.ts` pins the
 * result to `test/fixtures/llamacpp/engine-contract.json`, which the `--help` checks and the surface
 * diff (`scripts/lib/llama-help.mjs`) read, so a builder change shows up as a reviewable JSON diff.
 *
 * Derivation: `planLlamaArgs` over a config matrix (a base, every single variant, every pair) at every
 * build gate's edge (`g - 1`, `g`). The gates are step functions, so presence between two sampled
 * builds is constant and compresses exactly into `[from, until)` ranges. Upstream provider only: ik
 * and TurboQuant builds are other engines with their own flags.
 */
import * as llamaArgs from '../../src/runtime/llamacpp/args.js'
import { buildEmbeddingArgs } from '../../src/embedding/args.js'
import { EMBEDDING_CONTENT_PARTS_MIN_BUILD } from '../../src/embedding/model-facts.js'
import { buildUpstreamDecisionArgs } from '../../src/decision/args.js'
import { UPSTREAM_DECISION_MIN_BUILD } from '../../src/decision/upstream-version.js'
import { getBackendArchiveName, gpuFamilyConcreteRe } from '../../src/backend/catalog/index.js'
import { determineSupportedBackends, normalizeFeatures } from '../../src/backend/select/index.js'
import type { LlamacppConfig } from '../../src/contracts/index.js'
import { CONTRACT_ROUTES, CONTRACT_STRINGS } from './llamacpp-engine-strings.js'
import type { ContractRoute, ContractString } from './llamacpp-engine-strings.js'

export interface BuildRange {
  /** First build that has it; `null` = every build. */
  from: number | null
  /** First build that no longer has it; `null` = still has it. */
  until: number | null
}

export interface ContractValue {
  value: string
  builds: BuildRange[]
  /** Emitted only after the `-h` probe advertised it, so a build without it is not a break. */
  probe_gated?: true
}

/**
 * Where a flag comes from. `chat-dflash` is the chat builder on a build whose `-h` advertised
 * `--spec-type draft-dflash` (the probe in src/runtime/llamacpp/probe.ts): what only it emits is never
 * required of a build, because core would not take that branch there.
 */
export type Emitter = 'chat' | 'chat-dflash' | 'embedding' | 'decision-upstream'

export const EMITTERS: ReadonlyArray<{ name: Emitter; source: string; probe_gated: boolean }> = [
  { name: 'chat', source: 'src/runtime/llamacpp/args.ts', probe_gated: false },
  { name: 'chat-dflash', source: 'src/runtime/llamacpp/args.ts', probe_gated: true },
  { name: 'embedding', source: 'src/embedding/args.ts', probe_gated: false },
  { name: 'decision-upstream', source: 'src/decision/args.ts', probe_gated: false },
]

export interface ContractFlag {
  flag: string
  severity: 'break'
  emitters: Partial<Record<Emitter, BuildRange[]>>
  values?: ContractValue[]
}

/** A release archive core installs: one backend id of one platform. */
export interface ContractAsset {
  platform: string
  backend: string
  /** The platform's first backend, the one every host of it runs (`determineSupportedBackends`). */
  cpu: boolean
  /** Regex source of the archive name, `{tag}` standing for the release tag. */
  asset: string
}

export interface EngineContract {
  schema: 'atomic-engine-contract'
  schema_version: 1
  engine: 'llamacpp-upstream'
  generated_by: string
  emitters: typeof EMITTERS
  build_gates: Array<{ name: string; build: number; source: string }>
  invocations: Array<{ argv: string[]; source: string; expect: 'exit-0' }>
  env: Array<{ name: string; severity: 'break' | 'warn'; source: string }>
  flags: ContractFlag[]
  assets: { core_backends: ContractAsset[] }
  /** Log lines and bodies core matches (llamacpp-engine-strings.ts). */
  strings: ContractString[]
  /** Routes core calls on a session, and the fields it reads from their answers. */
  routes: ContractRoute[]
  upstream: {
    repo: string
    watched_paths: Array<{ path: string; why: string }>
    release_note_keywords: Array<{ pattern: string; severity: 'warn' | 'info' }>
  }
}

/** Flags whose next argv token is one of a closed set the engine has to accept. */
const CLOSED_VALUE_FLAGS = new Set([
  '--flash-attn',
  '--load-mode',
  '--fit',
  '--spec-type',
  '--pooling',
  '--cache-type-k',
  '--cache-type-v',
  '--split-mode',
  '--rope-scaling',
])

/** A token that names a flag (`-m`, `--fit`), not a value (`-1`, `/p`, `on`). */
export const FLAG_TOKEN = /^--?[A-Za-z]/

/**
 * Index 0 is the base; the rest are the values worth trying. A new `LlamacppConfig` field fails
 * typecheck here until someone decides how it can change the argv. The base is "armed": draft paths
 * and the dflash probe are set, so one toggle reaches each speculative branch.
 */
const VARIANTS: { [K in keyof LlamacppConfig]: ReadonlyArray<LlamacppConfig[K]> } = {
  version_backend: [''], // set per build below
  auto_unload: [false],
  timeout: [120],
  llamacpp_env: [''],
  extra_args: [''], // user arguments are not core's surface
  reasoning_preserve: [false, true],
  mtp: [false, true],
  mtp_draft_path: ['', '/mtp-draft.gguf'],
  dflash: [false, true],
  dflash_draft_path: ['/dflash-draft.gguf', ''],
  dflash_spec_supported: [true, false],
  dflash_n_max: [0, 8],
  concurrent_mode: [false, true],
  concurrent_slots: [8, 4],
  expose_metrics: [false, true],
  parallel: [1, 0, 4],
  cont_batching: [false, true],
  fit: [true, false],
  fit_target: ['', '2048'],
  fit_ctx: ['', '8192'],
  threads: [0, 4],
  threads_batch: [0, 4],
  ctx_shift: [false, true],
  ctx_size: [2048, 0],
  n_gpu_layers: [100, 20],
  n_predict: [0, 128],
  batch_size: [0, 1024],
  ubatch_size: [0, 256],
  device: ['', 'CUDA0'],
  split_mode: ['layer', 'row', 'none', 'tensor'],
  main_gpu: [0, 1],
  flash_attn: ['auto', 'on', 'off'],
  no_mmap: [false, true],
  mlock: [false, true],
  no_kv_offload: [false, true],
  cache_type_k: ['f16', ...llamaArgs.STANDARD_CACHE_TYPES.filter((t) => t !== 'f16'), 'turbo3'],
  cache_type_v: ['f16', ...llamaArgs.STANDARD_CACHE_TYPES.filter((t) => t !== 'f16'), 'turbo3'],
  defrag_thold: [0.1, 0.5],
  rope_scaling: ['none', 'linear', 'yarn'],
  rope_scale: [1, 2],
  rope_freq_base: [0, 10000],
  rope_freq_scale: [1, 0.5],
  chat_template: ['', 'chatml'],
  offload_mmproj: [true, false],
  cpu_moe: [false, true],
  n_cpu_moe: [0, 4],
  override_tensor_buffer_t: ['', 'exps=CPU'],
}

interface Input {
  isEmbedding: boolean
  mmprojPath: string | null
  backend: string
}

const INPUT_VARIANTS: { [K in keyof Input]: ReadonlyArray<Input[K]> } = {
  isEmbedding: [false, true],
  mmprojPath: [null, '/mmproj.gguf'],
  // Vulkan turns flash attention `auto` off, which decides whether `--cache-type-v` is emitted.
  backend: ['linux-cpu-x64', 'linux-vulkan-x64'],
}

type Atom = { config: Partial<LlamacppConfig> } | { input: Partial<Input> }

function atoms(): Atom[] {
  const out: Atom[] = []
  for (const [key, values] of Object.entries(VARIANTS))
    for (const value of values.slice(1)) out.push({ config: { [key]: value } })
  for (const [key, values] of Object.entries(INPUT_VARIANTS))
    for (const value of values.slice(1)) out.push({ input: { [key]: value } })
  return out
}

/** The base, every single atom, and every pair of atoms. */
function cases(): Array<{ config: LlamacppConfig; input: Input }> {
  const base = Object.fromEntries(
    Object.entries(VARIANTS).map(([k, v]) => [k, v[0]])
  ) as unknown as LlamacppConfig
  const baseInput = Object.fromEntries(
    Object.entries(INPUT_VARIANTS).map(([k, v]) => [k, v[0]])
  ) as unknown as Input
  const list = atoms()
  const apply = (picked: Atom[]) => {
    const config = { ...base }
    const input = { ...baseInput }
    for (const atom of picked) {
      if ('config' in atom) Object.assign(config, atom.config)
      else Object.assign(input, atom.input)
    }
    return { config, input }
  }
  const out = [apply([])]
  for (let i = 0; i < list.length; i++) {
    out.push(apply([list[i] as Atom]))
    for (let j = i + 1; j < list.length; j++) out.push(apply([list[i] as Atom, list[j] as Atom]))
  }
  return out
}

/** Every exported `*_MIN_BUILD` of the chat argv builder, picked up by name. */
export function argsBuildGates(): Array<{ name: string; build: number }> {
  return Object.entries(llamaArgs as Record<string, unknown>)
    .filter((e): e is [string, number] => e[0].endsWith('_MIN_BUILD') && typeof e[1] === 'number')
    .map(([name, build]) => ({ name, build }))
    .sort((a, b) => a.build - b.build || a.name.localeCompare(b.name))
}

/** The sampled builds: 1 and each gate's edge. */
export function sampledBuilds(): number[] {
  return [...new Set([1, ...argsBuildGates().flatMap((g) => [g.build - 1, g.build])])].sort((a, b) => a - b)
}

/** Present-at sets → `[from, until)` ranges over the sampled builds. */
export function toRanges(present: ReadonlySet<number>, builds: readonly number[]): BuildRange[] {
  const ranges: BuildRange[] = []
  let open: number | null | undefined
  builds.forEach((build, i) => {
    const has = present.has(build)
    if (has && open === undefined) open = i === 0 ? null : build
    if (!has && open !== undefined) {
      ranges.push({ from: open, until: build })
      open = undefined
    }
  })
  if (open !== undefined) ranges.push({ from: open, until: null })
  return ranges
}

type Presence = Map<string, { builds: Set<number>; values: Map<string, Set<number>> }>

function record(presence: Presence, argv: readonly string[], build: number): void {
  argv.forEach((token, i) => {
    if (!FLAG_TOKEN.test(token)) return
    const entry = presence.get(token) ?? { builds: new Set<number>(), values: new Map<string, Set<number>>() }
    entry.builds.add(build)
    const value = argv[i + 1]
    // A bare `--flash-attn` (before b6325) is followed by the next flag, not a value.
    if (CLOSED_VALUE_FLAGS.has(token) && value !== undefined && !FLAG_TOKEN.test(value)) {
      const seen = entry.values.get(value) ?? new Set<number>()
      seen.add(build)
      entry.values.set(value, seen)
    }
    presence.set(token, entry)
  })
}

/**
 * What the chat builder emits for the upstream provider, by flag and build: unconditionally (`chat`)
 * and on a build whose `-h` advertised DFlash (`chat-dflash`).
 */
function chatPresence(builds: readonly number[]): { chat: Presence; dflash: Presence } {
  const chat: Presence = new Map()
  const dflash: Presence = new Map()
  for (const { config, input } of cases()) {
    const probed = config.dflash && config.dflash_spec_supported && config.dflash_draft_path !== ''
    for (const build of builds) {
      const { argv } = llamaArgs.planLlamaArgs(
        { ...config, version_backend: `b${build}/${input.backend}` },
        {
          provider: 'llamacpp-upstream',
          isEmbedding: input.isEmbedding,
          modelId: 'm',
          modelPath: '/m.gguf',
          port: 8080,
          mmprojPath: input.mmprojPath,
        }
      )
      record(probed ? dflash : chat, argv, build)
    }
  }
  return { chat, dflash }
}

/** The embedding module's argv: no build gates of its own, a projector only from typed content parts. */
function embeddingPresence(builds: readonly number[]): Presence {
  const presence: Presence = new Map()
  for (const build of builds) {
    for (const mmproj of [false, true]) {
      if (mmproj && build < EMBEDDING_CONTENT_PARTS_MIN_BUILD) continue
      for (const pooling of [undefined, 'none', 'mean', 'cls', 'last', 'rank']) {
        const argv = buildEmbeddingArgs({
          modelPath: '/e.gguf',
          ...(mmproj ? { mmprojPath: '/p.gguf', imageMaxTokens: 256 } : {}),
          modelId: 'e',
          ctxSize: 2048,
          ...(pooling ? { pooling } : {}),
          threads: 4,
          port: 8080,
        })
        record(presence, argv, build)
      }
    }
  }
  return presence
}

/** Upstream decision models: stock llama.cpp from `UPSTREAM_DECISION_MIN_BUILD`. */
function decisionPresence(builds: readonly number[]): Presence {
  const presence: Presence = new Map()
  for (const build of builds) {
    if (build < UPSTREAM_DECISION_MIN_BUILD) continue
    for (const mmproj of [false, true])
      for (const wholePromptUbatch of [false, true]) {
        const argv = buildUpstreamDecisionArgs(
          { modelPath: '/d.gguf', modelId: 'd', threads: 4, port: 8080 },
          { ctxSize: 2048, wholePromptUbatch, ...(mmproj ? { mmprojPath: '/p.gguf' } : {}) }
        )
        record(presence, argv, build)
      }
  }
  return presence
}

/** The platforms core ships for, as `determineSupportedBackends` spells them. */
const ASSET_PLATFORMS: ReadonlyArray<{ platform: string; os: string; arch: string }> = [
  { platform: 'linux-x64', os: 'linux', arch: 'x86_64' },
  { platform: 'linux-arm64', os: 'linux', arch: 'aarch64' },
  { platform: 'macos-x64', os: 'macos', arch: 'x86_64' },
  { platform: 'macos-arm64', os: 'macos', arch: 'aarch64' },
  { platform: 'windows-x64', os: 'windows', arch: 'x86_64' },
  { platform: 'windows-arm64', os: 'windows', arch: 'aarch64' },
]

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The archive-name pattern of a backend id. A minor-less GPU family (`win-cuda-13-x64`,
 * `win-rocm-x64`) takes whichever toolkit minor the release carries, so its concrete-id regex is
 * turned into a sample id (`9999` for each free number), named, and the sample freed again.
 */
export function backendAssetPattern(backend: string): string {
  const family = gpuFamilyConcreteRe(backend)
  const id = family
    ? family.source
        .replace(/^\^|\$$/g, '')
        .replace(/\(\\d\+\)/g, '9999')
        .replace(/\((\d+)\)/g, '$1')
        .replace(/\\\./g, '.')
    : backend
  return escapeRegExp(getBackendArchiveName('{tag}', id))
    .replace(/9999/g, '\\d+')
    .replace('\\{tag\\}', '{tag}')
}

/** Every backend core installs, per platform, with every hardware feature on. */
export function coreBackendAssets(): ContractAsset[] {
  const all = normalizeFeatures({ cuda12: true, cuda13: true, vulkan: true, rocm: true, opencl: true })
  return ASSET_PLATFORMS.flatMap(({ platform, os, arch }) =>
    determineSupportedBackends(os, arch, all).map((backend, i) => ({
      platform,
      backend,
      cpu: i === 0,
      asset: backendAssetPattern(backend),
    }))
  )
}

export function deriveLlamaEngineContract(): EngineContract {
  const builds = [
    ...new Set([
      ...sampledBuilds(),
      UPSTREAM_DECISION_MIN_BUILD - 1,
      UPSTREAM_DECISION_MIN_BUILD,
      EMBEDDING_CONTENT_PARTS_MIN_BUILD - 1,
      EMBEDDING_CONTENT_PARTS_MIN_BUILD,
    ]),
  ].sort((a, b) => a - b)
  const chat = chatPresence(builds)
  const byEmitter: Record<Emitter, Presence> = {
    'chat': chat.chat,
    'chat-dflash': chat.dflash,
    'embedding': embeddingPresence(builds),
    'decision-upstream': decisionPresence(builds),
  }
  const flagNames = [...new Set(Object.values(byEmitter).flatMap((p) => [...p.keys()]))].sort()
  const probeGated = new Set(EMITTERS.filter((e) => e.probe_gated).map((e) => e.name))
  const flags: ContractFlag[] = flagNames.map((flag) => {
    const emitters: ContractFlag['emitters'] = {}
    const values = new Map<string, { builds: Set<number>; unprobed: boolean }>()
    for (const [emitter, presence] of Object.entries(byEmitter) as Array<[Emitter, Presence]>) {
      const entry = presence.get(flag)
      if (!entry) continue
      emitters[emitter] = toRanges(entry.builds, builds)
      for (const [value, seen] of entry.values) {
        const merged = values.get(value) ?? { builds: new Set<number>(), unprobed: false }
        for (const b of seen) merged.builds.add(b)
        merged.unprobed ||= !probeGated.has(emitter)
        values.set(value, merged)
      }
    }
    const contractFlag: ContractFlag = { flag, severity: 'break', emitters }
    if (values.size > 0)
      contractFlag.values = [...values.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([value, { builds: seen, unprobed }]) => ({
          value,
          builds: toRanges(seen, builds),
          ...(unprobed ? {} : { probe_gated: true as const }),
        }))
    return contractFlag
  })

  return {
    schema: 'atomic-engine-contract',
    schema_version: 1,
    engine: 'llamacpp-upstream',
    generated_by: 'npx vitest run --project contract -u test/contract/llamacpp-engine-contract.test.ts',
    emitters: EMITTERS,
    build_gates: [
      ...argsBuildGates().map((g) => ({ ...g, source: 'src/runtime/llamacpp/args.ts' })),
      {
        name: 'EMBEDDING_CONTENT_PARTS_MIN_BUILD',
        build: EMBEDDING_CONTENT_PARTS_MIN_BUILD,
        source: 'src/embedding/model-facts.ts',
      },
      {
        name: 'UPSTREAM_DECISION_MIN_BUILD',
        build: UPSTREAM_DECISION_MIN_BUILD,
        source: 'src/decision/upstream-version.ts',
      },
    ],
    invocations: [
      { argv: ['-h'], source: 'src/runtime/llamacpp/probe.ts', expect: 'exit-0' },
      { argv: ['--version'], source: 'src/backend/install/service.ts', expect: 'exit-0' },
      { argv: ['--list-devices'], source: 'src/runtime/llamacpp/runtime.ts', expect: 'exit-0' },
    ],
    env: [
      { name: 'LLAMA_API_KEY', severity: 'break', source: 'src/runtime/llamacpp/load-plan.ts' },
      { name: 'LLAMA_ARG_TIMEOUT', severity: 'warn', source: 'src/runtime/llamacpp/load-plan.ts' },
    ],
    flags,
    assets: { core_backends: coreBackendAssets() },
    strings: CONTRACT_STRINGS,
    routes: CONTRACT_ROUTES,
    upstream: {
      repo: 'ggml-org/llama.cpp',
      watched_paths: [
        { path: 'common/arg.cpp', why: 'every flag, -h, --version and --list-devices' },
        { path: 'common/speculative.cpp', why: '--spec-type names, MTP context errors' },
        { path: 'common/log.cpp', why: 'log level and line prefixes the markers assume' },
        { path: 'tools/server/server.cpp', why: 'routes, `model loaded` / `listening on`' },
        { path: 'tools/server/server-http.cpp', why: 'bind error, 503 Loading model, 401' },
        {
          path: 'tools/server/server-context.cpp',
          why: '/props, /v1/models, /health, context overflow, compute errors',
        },
        { path: 'tools/server/server-common.cpp', why: 'error types → HTTP codes, media errors' },
        { path: 'tools/server/server-task.cpp', why: 'timings, usage, n_prompt_tokens / n_ctx' },
        { path: 'tools/server/server-chat.cpp', why: 'reasoning_content' },
        { path: 'tools/mtmd/clip.cpp', why: 'unknown projector type' },
        { path: 'src/llama-model.cpp', why: 'architecture errors, offload and buffer-size log lines' },
        { path: 'src/llama-model-loader.cpp', why: 'missing keys, tensor count, corrupt file' },
        {
          path: 'src/llama-model-loader.h',
          why: 'tensor data out of the file bounds: corrupted or incomplete',
        },
        { path: 'src/llama.cpp', why: 'error loading model hyperparameters' },
        { path: 'src/llama-mmap.cpp', why: 'unexpectedly reached end of file' },
        { path: 'src/llama-context.cpp', why: 'MTP warnings, compute and decode errors' },
        { path: 'src/llama-arch.cpp', why: 'architecture names and GGUF keys core reads' },
        { path: 'ggml/src/ggml-backend-reg.cpp', why: 'load_backend log lines' },
        { path: 'ggml/src/gguf.cpp', why: 'invalid magic, failed to read tensor' },
        { path: 'ggml/src/ggml-backend-meta.cpp', why: 'tensor split aborts (GGML_ABORT names this file)' },
        { path: '.github/workflows/release.yml', why: 'asset names and archive layout' },
      ],
      release_note_keywords: [
        { pattern: 'deprecat', severity: 'warn' },
        { pattern: 'remove', severity: 'warn' },
        { pattern: 'rename', severity: 'warn' },
        { pattern: 'breaking', severity: 'warn' },
        { pattern: '^(args|server|common)[:(]', severity: 'info' },
      ],
    },
  }
}
