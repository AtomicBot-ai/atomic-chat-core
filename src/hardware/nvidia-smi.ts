/**
 * `nvidia-smi --query-gpu=… --format=csv,noheader,nounits`: the one tool that knows an NVIDIA driver's
 * exact version and a GPU's compute capability without NVML being linked, both of which decide the
 * CUDA tier a backend is chosen from.
 *
 * Pure: the arguments to run, the CSV that comes back, the `GpuInfo` it becomes. The I/O runner picks
 * the first candidate path that exists and retries with `NVIDIA_SMI_FIELDS_LEGACY` when the driver is
 * too old to know `compute_cap` (added in 470).
 */

import type { GpuInfo } from '../contracts/index.js'

export const NVIDIA_SMI_FIELDS: readonly string[] = [
  'index',
  'name',
  'uuid',
  'memory.total',
  'driver_version',
  'compute_cap',
  'pci.bus_id',
]

/** Drivers before 470 refuse `compute_cap`; the compute capability is then `''` (unknown). */
export const NVIDIA_SMI_FIELDS_LEGACY: readonly string[] = NVIDIA_SMI_FIELDS.filter(
  (f) => f !== 'compute_cap'
)

export function nvidiaSmiArgs(fields: readonly string[]): string[] {
  return [`--query-gpu=${fields.join(',')}`, '--format=csv,noheader,nounits']
}

/** `Field "compute_cap" is not a valid field to query.` — the driver is older than the field. */
export function isUnknownFieldError(stderr: string): boolean {
  return /not a valid field to query/i.test(stderr)
}

/** One CSV row keyed by field name; a value the tool could not report is absent. */
export type NvidiaSmiRow = Record<string, string | undefined>

const UNREPORTED = new Set([
  '[N/A]',
  '[Not Supported]',
  'N/A',
  '[Unknown Error]',
  '[Insufficient Permissions]',
])

/** A header cell is the field name, with ` [MiB]`-style units when the query asked for them. */
function isHeaderLine(cells: readonly string[], fields: readonly string[]): boolean {
  return cells.every((cell, i) => cell.replace(/\s*\[[^\]]*\]$/, '') === fields[i])
}

/**
 * Rows in `fields` order. Lines whose column count does not match (a warning the tool printed to
 * stdout, an empty trailing line) are dropped rather than mis-keyed, and so is a header line (a
 * query without `noheader`), which would otherwise read as a card named `name`.
 */
export function parseNvidiaSmiCsv(stdout: string, fields: readonly string[]): NvidiaSmiRow[] {
  const rows: NvidiaSmiRow[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const cells = line.split(',').map((cell) => cell.trim())
    if (cells.length !== fields.length || isHeaderLine(cells, fields)) continue
    const row: NvidiaSmiRow = {}
    fields.forEach((field, i) => {
      const cell = cells[i] ?? ''
      if (cell !== '' && !UNREPORTED.has(cell)) row[field] = cell
    })
    rows.push(row)
  }
  return rows
}

/**
 * The plugin's `GpuInfo` for one nvidia-smi row: NVML's uuid without `GPU-`, MiB (with or without the
 * ` MiB` a query without `nounits` appends), `''` for an unknown compute capability. An unreported
 * size — `[N/A]` on a unified-memory card such as the GB10 — is `total_memory: 0`, the app's own
 * "unknown" in this contract, never `NaN`.
 */
export function nvidiaGpuFromRow(row: NvidiaSmiRow): GpuInfo {
  const index = Number(row['index'])
  const memory = Number((row['memory.total'] ?? '').replace(/\s*MiB$/, ''))
  return {
    name: row['name'] ?? 'NVIDIA GPU',
    total_memory: Number.isFinite(memory) && memory > 0 ? Math.floor(memory) : 0,
    vendor: 'NVIDIA',
    uuid: (row['uuid'] ?? '').replace(/^GPU-/i, ''),
    driver_version: row['driver_version'] ?? '',
    nvidia_info: {
      index: Number.isInteger(index) && index >= 0 ? index : 0,
      compute_capability: row['compute_cap'] ?? '',
    },
    vulkan_info: null,
  }
}

/** The row's PCI bus id in sysfs spelling, for matching against `/sys/class/drm`; absent when unreported. */
export function nvidiaBusIdOf(row: NvidiaSmiRow): string | undefined {
  const raw = row['pci.bus_id']
  return raw === undefined ? undefined : normalizePciBusId(raw)
}

/**
 * nvidia-smi prints a 32-bit domain (`00000000:01:00.0`); sysfs and vulkaninfo a 16-bit one
 * (`0000:01:00.0`). Lower case, four-digit domain; anything else is returned trimmed and lower-cased.
 */
export function normalizePciBusId(busId: string): string {
  const m = /^([0-9a-f]+):([0-9a-f]{2}):([0-9a-f]{2})\.([0-9a-f])$/i.exec(busId.trim())
  if (!m) return busId.trim().toLowerCase()
  const domain = (m[1] ?? '').toLowerCase().slice(-4).padStart(4, '0')
  return `${domain}:${m[2]}:${m[3]}.${m[4]}`.toLowerCase()
}

/**
 * Where `nvidia-smi` lives, in the order to try: PATH first, then the driver's own install
 * locations, which are not on PATH for a service or a fresh shell. WSL ships it under `/usr/lib/wsl/lib`.
 */
export function nvidiaSmiCandidates(platform: NodeJS.Platform | string, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    const systemRoot = env['SystemRoot'] ?? env['SYSTEMROOT'] ?? 'C:\\Windows'
    const programFiles = env['ProgramFiles'] ?? env['PROGRAMFILES'] ?? 'C:\\Program Files'
    return [
      'nvidia-smi',
      `${systemRoot}\\System32\\nvidia-smi.exe`,
      `${programFiles}\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe`,
    ]
  }
  if (platform === 'linux') return ['nvidia-smi', '/usr/bin/nvidia-smi', '/usr/lib/wsl/lib/nvidia-smi']
  return []
}
