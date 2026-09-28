/**
 * CPU instruction-set flags in the spelling `tauri-plugin-hardware` emits, from the three places the
 * probe can read them: `/proc/cpuinfo` (Linux), `sysctl machdep.cpu.*` (Intel Macs) and
 * `IsProcessorFeaturePresent` (Windows, through PowerShell).
 *
 * Pure: text in, names out. The consumers (`isUnsupportedNoAvxCpu`, `getSupportedFeatures`) look for
 * `avx`, `avx2` and `avx512*`; the rest is what the app's Hardware page lists.
 */

/** The 27 names the Rust plugin reports (its `cpu_extensions` table), in its order. */
export const PLUGIN_CPU_EXTENSIONS: readonly string[] = [
  'fpu',
  'mmx',
  'sse',
  'sse2',
  'sse3',
  'ssse3',
  'sse4_1',
  'sse4_2',
  'pclmulqdq',
  'avx',
  'avx2',
  'avx512_f',
  'avx512_dq',
  'avx512_ifma',
  'avx512_pf',
  'avx512_er',
  'avx512_cd',
  'avx512_bw',
  'avx512_vl',
  'avx512_vbmi',
  'avx512_vbmi2',
  'avx512_vnni',
  'avx512_bitalg',
  'avx512_vpopcntdq',
  'avx512_vp2intersect',
  'aes',
  'f16c',
]

/** Linux `flags:` spelling → plugin spelling. Names not listed here are not something the plugin reports. */
const LINUX_FLAGS: Readonly<Record<string, string>> = {
  fpu: 'fpu',
  mmx: 'mmx',
  sse: 'sse',
  sse2: 'sse2',
  pni: 'sse3',
  ssse3: 'ssse3',
  sse4_1: 'sse4_1',
  sse4_2: 'sse4_2',
  pclmulqdq: 'pclmulqdq',
  avx: 'avx',
  avx2: 'avx2',
  avx512f: 'avx512_f',
  avx512dq: 'avx512_dq',
  avx512ifma: 'avx512_ifma',
  avx512pf: 'avx512_pf',
  avx512er: 'avx512_er',
  avx512cd: 'avx512_cd',
  avx512bw: 'avx512_bw',
  avx512vl: 'avx512_vl',
  avx512vbmi: 'avx512_vbmi',
  avx512_vbmi2: 'avx512_vbmi2',
  avx512_vnni: 'avx512_vnni',
  avx512_bitalg: 'avx512_bitalg',
  avx512_vpopcntdq: 'avx512_vpopcntdq',
  avx512_vp2intersect: 'avx512_vp2intersect',
  aes: 'aes',
  f16c: 'f16c',
}

/** `machdep.cpu.features` / `machdep.cpu.leaf7_features` spelling (upper case) → plugin spelling. */
const DARWIN_FEATURES: Readonly<Record<string, string>> = {
  'FPU': 'fpu',
  'MMX': 'mmx',
  'SSE': 'sse',
  'SSE2': 'sse2',
  'SSE3': 'sse3',
  'SSSE3': 'ssse3',
  'SSE4.1': 'sse4_1',
  'SSE4.2': 'sse4_2',
  'PCLMULQDQ': 'pclmulqdq',
  'AVX1.0': 'avx',
  'AVX2': 'avx2',
  'AVX512F': 'avx512_f',
  'AVX512DQ': 'avx512_dq',
  'AVX512IFMA': 'avx512_ifma',
  'AVX512PF': 'avx512_pf',
  'AVX512ER': 'avx512_er',
  'AVX512CD': 'avx512_cd',
  'AVX512BW': 'avx512_bw',
  'AVX512VL': 'avx512_vl',
  'AVX512VBMI': 'avx512_vbmi',
  'AVX512VBMI2': 'avx512_vbmi2',
  'AVX512VNNI': 'avx512_vnni',
  'AVX512BITALG': 'avx512_bitalg',
  'AVX512VPOPCNTDQ': 'avx512_vpopcntdq',
  'AVX512VP2INTERSECT': 'avx512_vp2intersect',
  'AES': 'aes',
  'F16C': 'f16c',
}

/**
 * `IsProcessorFeaturePresent` feature numbers (winnt.h `PF_*`) → plugin spelling. Only the flags the
 * kernel exposes this way; the AVX-512 sub-features have no PF number, so Windows reports `avx512_f` alone.
 */
export const WINDOWS_PROCESSOR_FEATURES: Readonly<Record<string, string>> = {
  '3': 'mmx',
  '6': 'sse',
  '10': 'sse2',
  '13': 'sse3',
  '36': 'ssse3',
  '37': 'sse4_1',
  '38': 'sse4_2',
  '39': 'avx',
  '40': 'avx2',
  '41': 'avx512_f',
}

/** The first Windows build whose `IsProcessorFeaturePresent` knows PF 39–41 (Server 2022 / Windows 11). */
const WINDOWS_BUILD_KNOWING_AVX_PF = 20348

export interface ProcCpuinfo {
  /** `model name` of the first processor (x86) or `Model name` / `Hardware` when present; otherwise absent. */
  modelName?: string
  /**
   * The plugin-spelled flags of the first processor; `undefined` when the file has no `flags` line,
   * which is how arm64 kernels write it (they list `Features` instead, none of which the plugin reports).
   */
  flags: string[] | undefined
  /** Distinct (physical id, core id) pairs, or the first `cpu cores` value; absent on kernels without either. */
  physicalCores?: number
}

/** In `PLUGIN_CPU_EXTENSIONS` order, each name once. */
function inPluginOrder(names: Iterable<string>): string[] {
  const present = new Set(names)
  return PLUGIN_CPU_EXTENSIONS.filter((name) => present.has(name))
}

/** Read `/proc/cpuinfo`. Only the first processor's flags are read: cores of one socket share them. */
export function parseProcCpuinfo(text: string): ProcCpuinfo {
  let modelName: string | undefined
  let flags: string[] | undefined
  let firstCpuCores: number | undefined
  const cores = new Set<string>()
  let physicalId = '0'
  for (const rawLine of text.split('\n')) {
    const colon = rawLine.indexOf(':')
    if (colon < 0) continue
    const key = rawLine.slice(0, colon).trim().toLowerCase()
    const value = rawLine.slice(colon + 1).trim()
    if (key === 'model name' && modelName === undefined && value !== '') modelName = value
    else if (key === 'hardware' && modelName === undefined && value !== '') modelName = value
    else if (key === 'flags' && flags === undefined) {
      const mapped = new Set<string>()
      for (const flag of value.split(/\s+/)) {
        const name = LINUX_FLAGS[flag]
        if (name) mapped.add(name)
      }
      // The plugin always lists `fpu` on x86: every x86-64 CPU has one, whatever the kernel prints.
      mapped.add('fpu')
      flags = inPluginOrder(mapped)
    } else if (key === 'physical id') physicalId = value
    else if (key === 'core id') cores.add(`${physicalId}:${value}`)
    else if (key === 'cpu cores' && firstCpuCores === undefined) {
      const n = Number(value)
      if (Number.isInteger(n) && n > 0) firstCpuCores = n
    }
  }
  const physicalCores = cores.size > 0 ? cores.size : firstCpuCores
  return {
    ...(modelName !== undefined ? { modelName } : {}),
    flags,
    ...(physicalCores !== undefined ? { physicalCores } : {}),
  }
}

/**
 * Intel Macs: `sysctl -n machdep.cpu.features machdep.cpu.leaf7_features`, two space-separated lists.
 * Apple silicon has neither key and reports no x86 flags.
 */
export function parseDarwinCpuFeatures(features: string, leaf7: string): string[] {
  const mapped = new Set<string>()
  for (const token of `${features} ${leaf7}`.split(/\s+/)) {
    const name = DARWIN_FEATURES[token.toUpperCase()]
    if (name) mapped.add(name)
  }
  return inPluginOrder(mapped)
}

/**
 * Windows: the `IsProcessorFeaturePresent` answers keyed by feature number, as the PowerShell probe
 * returns them, or `null` when its `Add-Type` P/Invoke failed (Constrained Language Mode, no compiler).
 *
 * `undefined` means unknown, never "no flags": a kernel older than build 20348 answers `false` for a
 * feature number it does not know, so a `false` for AVX (PF 39) there says nothing about the CPU and
 * must not block a CPU backend load.
 */
export function cpuExtensionsFromWindowsPf(
  pf: Record<string, boolean> | null,
  build: number,
  arch: string
): string[] | undefined {
  if (!isX86Arch(arch)) return []
  if (pf === null) return undefined
  if (pf['39'] === false && build < WINDOWS_BUILD_KNOWING_AVX_PF) return undefined
  const present = new Set<string>(['fpu'])
  for (const [number, name] of Object.entries(WINDOWS_PROCESSOR_FEATURES))
    if (pf[number] === true) present.add(name)
  return inPluginOrder(present)
}

/** Node (`x64`, `ia32`) and Rust (`x86_64`, `x86`) spellings, plus `amd64`. */
export function isX86Arch(arch: string): boolean {
  const a = arch.trim().toLowerCase()
  return a === 'x86_64' || a === 'x64' || a === 'amd64' || a === 'x86' || a === 'ia32'
}
