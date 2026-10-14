/**
 * `llama-server -h` held to the engine contract, against help screens captured from real ggml-org
 * builds (test/fixtures/llamacpp/). The history set replays the one upstream removal that broke core:
 * b10875 dropped `--mmap`/`--mlock` (ggml-org/llama.cpp#28334), which b10874 had already marked
 * deprecated, and which core survives only because the pack carries its real build number.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  checkHelp,
  diffHelp,
  findOption,
  hintChoices,
  parseLlamaHelp,
  requiredAt,
} from '../../scripts/lib/llama-help.mjs'
import type { ContractLike } from '../../scripts/lib/llama-help.mjs'
import { parseBinaryVersion } from '../../src/backend/version.js'
import { planLlamaArgs, withLlamacppDefaults } from '../../src/runtime/llamacpp/args.js'
import type { LlamacppConfig } from '../../src/contracts/index.js'

const fixture = (path: string) =>
  readFileSync(new URL(`../fixtures/llamacpp/${path}`, import.meta.url), 'utf8')
const help = (tag: string) => parseLlamaHelp(fixture(`help/${tag}.txt`))
const contract = JSON.parse(fixture('engine-contract.json')) as ContractLike

/** The contract a core without the load-mode gate would have had: `--no-mmap`/`--mlock` forever. */
function withoutLoadModeGate(c: ContractLike): ContractLike {
  return {
    ...c,
    flags: c.flags
      .filter((f) => f.flag !== '--load-mode')
      .map((f) =>
        f.flag === '--no-mmap' || f.flag === '--mlock'
          ? {
              ...f,
              emitters: Object.fromEntries(
                Object.keys(f.emitters).map((e) => [e, [{ from: null, until: null }]])
              ),
            }
          : f
      ),
  }
}

const severities = (findings: Array<{ severity: string; id: string }>, severity: string) =>
  findings.filter((f) => f.severity === severity).map((f) => f.id)

describe('parseLlamaHelp', () => {
  it('reads every captured build as a full help screen', () => {
    for (const tag of ['b10874', 'b10875', 'b11463', 'b11617']) expect(help(tag).length).toBeGreaterThan(200)
  })

  it('splits aliases from the value hint on the 40-column layout', () => {
    const options = parseLlamaHelp(
      [
        '----- common params -----',
        '',
        '-fa,   --flash-attn [on|off|auto]       set Flash Attention use',
        '                                        (env: LLAMA_ARG_FLASH_ATTN)',
        '-kvu,  --kv-unified, -no-kvu, --no-kv-unified',
        '                                        use single unified KV buffer',
        '--spec-type none,draft-simple,draft-mtp,draft-dflash',
        '                                        speculative decoding type',
        '-ngl,  --gpu-layers, --n-gpu-layers N   max. number of layers (default: -1)',
        '-ot,   --override-tensor <tensor name pattern>=<buffer type>,...',
        '                                        override tensor buffer type',
        '--mlock                                 DEPRECATED in favor of `--load-mode`: force system to keep model in',
        '                                        RAM',
      ].join('\r\n')
    )
    expect(options.map((o) => o.aliases)).toEqual([
      ['-fa', '--flash-attn'],
      ['-kvu', '--kv-unified', '-no-kvu', '--no-kv-unified'],
      ['--spec-type'],
      ['-ngl', '--gpu-layers', '--n-gpu-layers'],
      ['-ot', '--override-tensor'],
      ['--mlock'],
    ])
    expect(options.map((o) => o.hint)).toEqual([
      '[on|off|auto]',
      '',
      'none,draft-simple,draft-mtp,draft-dflash',
      'N',
      '<tensor name pattern>=<buffer type>,...',
      '',
    ])
    expect(options[0]?.env).toEqual(['LLAMA_ARG_FLASH_ATTN'])
    expect(options.map((o) => o.deprecated)).toEqual([false, false, false, false, false, true])
    expect(options[3]?.help).toContain('(default: -1)')
  })

  it('reads the choices a hint lists, and nothing from a free-form hint', () => {
    expect(hintChoices('[on|off|auto]')).toEqual(['on', 'off', 'auto'])
    expect(hintChoices('{none,mean,cls}')).toEqual(['none', 'mean', 'cls'])
    expect(hintChoices('<0|1>')).toEqual(['0', '1'])
    expect(hintChoices('none,draft-mtp,draft-dflash')).toEqual(['none', 'draft-mtp', 'draft-dflash'])
    expect(hintChoices('TYPE')).toBeUndefined()
    expect(hintChoices('<tensor name pattern>=<buffer type>,...')).toBeUndefined()
  })

  it('finds a flag by any of its spellings', () => {
    const options = help('b11617')
    expect(findOption(options, '-kvu')?.aliases).toContain('--kv-unified')
    expect(findOption(options, '--no-webui')?.aliases).toContain('--ui')
    expect(findOption(options, '--load-mode')?.aliases).toContain('-lm')
  })
})

describe('checkHelp against real builds', () => {
  it.each(['b11463', 'b11617'])('%s accepts every flag and value core emits for it', (tag) => {
    const findings = checkHelp(contract, Number(tag.slice(1)), help(tag))
    expect(severities(findings, 'break')).toEqual([])
    expect(severities(findings, 'error')).toEqual([])
  })

  it('warns that core still emits --defrag-thold, which upstream marks deprecated', () => {
    expect(severities(checkHelp(contract, 11617, help('b11617')), 'warn')).toContain(
      'help.deprecated/--defrag-thold'
    )
  })

  it('fails closed on output that is not a help screen', () => {
    expect(checkHelp(contract, 11617, parseLlamaHelp('error: invalid argument: -h\n'))).toEqual([
      expect.objectContaining({ id: 'help.parse', severity: 'error' }),
    ])
  })

  it('reports a probe-gated value as info, a listed value core needs as a break', () => {
    const options = parseLlamaHelp(
      fixture('help/b11617.txt').replace('draft-dflash,', '').replace(',draft-mtp', '')
    )
    const findings = checkHelp(contract, 11617, options)
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'help.flag_values/--spec-type=draft-dflash', severity: 'info' }),
        expect.objectContaining({ id: 'help.flag_values/--spec-type=draft-mtp', severity: 'break' }),
      ])
    )
  })
})

describe('history: b10875 removed --mmap and --mlock', () => {
  it('H1a: the diff names the removed flags, anticipated by the load-mode gate', () => {
    const findings = diffHelp(help('b10874'), help('b10875'), contract, 10875)
    expect(severities(findings, 'info')).toEqual(
      expect.arrayContaining([
        'help.diff/removed/--mlock',
        'help.diff/removed/--no-mmap',
        'help.diff/removed',
      ])
    )
    const others = findings.find((f) => f.id === 'help.diff/removed')?.evidence as { flags: string[] }
    expect(others.flags).toEqual(
      expect.arrayContaining(['--mmap', '-dio', '--direct-io', '-ndio', '--no-direct-io'])
    )
  })

  it('H1b: this core passes b10875; a core without the gate breaks on it', () => {
    expect(severities(checkHelp(contract, 10875, help('b10875')), 'break')).toEqual([])
    expect(severities(checkHelp(withoutLoadModeGate(contract), 10875, help('b10875')), 'break')).toEqual([
      'help.required_flags/--mlock',
      'help.required_flags/--no-mmap',
    ])
  })

  it('H1c: the argv for a pack labelled b10874 does not run on b10875; labelled b10875 it does', () => {
    const options = help('b10875')
    const known = (argv: string[]) => argv.filter((t) => /^--?[A-Za-z]/.test(t) && !findOption(options, t))
    const plan = (versionBackend: string) =>
      planLlamaArgs(baseConfig({ version_backend: versionBackend, no_mmap: true, mlock: true }), {
        provider: 'llamacpp-upstream',
        isEmbedding: false,
        modelId: 'm',
        modelPath: '/m.gguf',
        port: 8080,
      }).argv
    expect(known(plan('b10874/linux-cpu-x64'))).toEqual(['--no-mmap', '--mlock'])
    expect(known(plan('b10875/linux-cpu-x64'))).toEqual([])
  })

  it('H1d: b10874 already warned — the flags core emitted were marked deprecated', () => {
    expect(severities(checkHelp(contract, 10874, help('b10874')), 'warn')).toEqual(
      expect.arrayContaining(['help.deprecated/--mlock', 'help.deprecated/--no-mmap'])
    )
  })

  it('requires --load-mode from b10875 and --no-mmap before it', () => {
    const at = (build: number) => requiredAt(contract, build).map((r) => r.flag)
    expect(at(10874)).toEqual(expect.arrayContaining(['--no-mmap', '--mlock']))
    expect(at(10874)).not.toContain('--load-mode')
    expect(at(10875)).toContain('--load-mode')
    expect(at(10875)).not.toContain('--no-mmap')
  })
})

describe('H3: --version formats core reads the build from', () => {
  it.each([
    ['b10344', 10344],
    ['b10400', 10400],
    ['b11617', 11617],
  ])('%s → %i', (tag, build) => {
    expect(parseBinaryVersion(fixture(`version/${tag}.txt`))).toBe(build)
  })

  it('reads nothing from a format it does not know, which the live check reports', () => {
    expect(parseBinaryVersion('llama-server 1.2.3\nbuilt with clang\n')).toBeUndefined()
  })
})

function baseConfig(overrides: Partial<LlamacppConfig>): LlamacppConfig {
  return withLlamacppDefaults({
    version_backend: 'b1/linux-cpu-x64',
    auto_unload: false,
    timeout: 120,
    llamacpp_env: '',
    fit: true,
    fit_ctx: '',
    fit_target: '',
    n_gpu_layers: 100,
    offload_mmproj: true,
    cpu_moe: false,
    n_cpu_moe: 0,
    ctx_size: 2048,
    threads: 0,
    threads_batch: 0,
    n_predict: 0,
    batch_size: 0,
    ubatch_size: 0,
    device: '',
    split_mode: 'layer',
    main_gpu: 0,
    flash_attn: 'auto',
    cont_batching: false,
    no_mmap: false,
    mlock: false,
    no_kv_offload: false,
    cache_type_k: 'f16',
    cache_type_v: 'f16',
    defrag_thold: 0.1,
    rope_scaling: 'none',
    rope_scale: 1,
    rope_freq_base: 0,
    rope_freq_scale: 1,
    ctx_shift: false,
    ...overrides,
  })
}
