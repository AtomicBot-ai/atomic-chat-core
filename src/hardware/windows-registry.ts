/**
 * Windows GPUs from `reg.exe`, for when the PowerShell probe cannot run: AppLocker or AMSI blocking
 * `powershell.exe`, a cold start past its deadline, a broken WMI repository that answers no video
 * controller. `reg.exe` is a plain console tool: no execution policy, no script host, nothing for AMSI
 * to scan. It reads the same display class key the PowerShell script reads — one `NNNN` subkey per
 * installed display driver instance, with the driver's name (`DriverDesc`), vendor (`ProviderName`),
 * PCI ids (`MatchingDeviceId`), version and VRAM (`HardwareInformation.qwMemorySize`, or the 32-bit
 * `HardwareInformation.MemorySize`) — and the Khronos Vulkan driver registrations.
 *
 * What it cannot see is which of those driver instances belongs to a device that is present: a card
 * moved to another slot or replaced keeps its old key. So a vendor and device id is listed once (two
 * identical non-NVIDIA cards read as one), and an NVIDIA key counts only as often as `nvidia-smi`,
 * which is authoritative for NVIDIA, reports a GPU of that name. CPU flags have no cheap source
 * outside PowerShell (`wmic` is deprecated and gone from new installs) and stay unknown.
 *
 * Pure: the key names, the parse of `reg query` output and the adapter list. `probe-windows.ts` runs it.
 */

import { icdVendorOf } from './vulkan.js'
import { parsePnpDeviceId } from './windows-video.js'
import type { WindowsAdapter } from './windows-video.js'

const DISPLAY_CLASS_GUID = '{4d36e968-e325-11ce-bfc1-08002be10318}'
/** The display adapter class key, in `reg.exe` spelling. */
export const DISPLAY_CLASS_REG_KEY = `HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\${DISPLAY_CLASS_GUID}`
/** The Vulkan loader's driver registrations: one value per ICD manifest, named by its path. */
export const VULKAN_DRIVERS_REG_KEY = 'HKLM\\SOFTWARE\\Khronos\\Vulkan\\Drivers'

/** `reg.exe` from `%SystemRoot%`, not whatever `reg.exe` comes first on PATH. */
export function regExePath(env: NodeJS.ProcessEnv): string {
  return `${env['SystemRoot'] ?? env['SYSTEMROOT'] ?? 'C:\\Windows'}\\System32\\reg.exe`
}

/** One key, no recursion: its values, and its subkeys as lines of their own. */
export function regQueryArgs(key: string): string[] {
  return ['query', key]
}

export interface RegValue {
  name: string
  /** `REG_SZ`, `REG_DWORD`, `REG_QWORD`, `REG_BINARY`, `REG_MULTI_SZ`, … */
  type: string
  /** As `reg.exe` prints it: hex for numbers and binary, `\0` between the strings of a multi-string. */
  data: string
}

export interface RegKey {
  /** `HKEY_LOCAL_MACHINE\…`, as `reg.exe` prints it. */
  path: string
  values: RegValue[]
}

const VALUE_LINE = /^ {4}(.+?) {4}(REG_[A-Z0-9_]+)(?: {4}(.*))?$/

/**
 * `reg query` output: a key path at the start of a line, then its values indented four spaces
 * (`name    TYPE    data`); the subkeys of a non-recursive query follow as bare key paths. Error
 * lines (`ERROR: Access is denied.`) and blank lines are skipped. Tolerates CRLF, a BOM and the NULs
 * of UTF-16 output read as single bytes.
 */
export function parseRegQuery(text: string): RegKey[] {
  const keys: RegKey[] = []
  let current: RegKey | undefined
  for (const raw of text
    .replaceAll('\u0000', '')
    .replace(/^[\uFEFF\uFFFD]+/, '')
    .split(/\r?\n/)) {
    if (raw.startsWith('HKEY_')) {
      current = { path: raw.trimEnd(), values: [] }
      keys.push(current)
      continue
    }
    const m = VALUE_LINE.exec(raw.trimEnd())
    if (!m || !current) continue
    current.values.push({ name: m[1] as string, type: m[2] as string, data: (m[3] ?? '').trim() })
  }
  return keys
}

/** Whether `path` is one driver instance of the display class (`…\{4d36e968-…}\0003`). */
export function isDisplayDriverKey(path: string): boolean {
  const i = path.toLowerCase().lastIndexOf(`\\${DISPLAY_CLASS_GUID}\\`)
  return i >= 0 && /^\d{4}$/.test(path.slice(i + DISPLAY_CLASS_GUID.length + 2))
}

/** A `REG_DWORD`/`REG_QWORD` (`0x…`) or a little-endian `REG_BINARY`, as a number; `undefined` for anything else. */
export function regNumber(value: RegValue | undefined): number | undefined {
  if (!value) return undefined
  if (value.type === 'REG_DWORD' || value.type === 'REG_QWORD') {
    const m = /^0x([0-9a-f]+)$/i.exec(value.data)
    return m ? Number.parseInt(m[1] as string, 16) : undefined
  }
  if (value.type === 'REG_BINARY') {
    const hex = value.data.replace(/\s+/g, '')
    if (hex === '' || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex) || hex.length > 16) return undefined
    let n = 0
    for (let i = hex.length - 2; i >= 0; i -= 2) n = n * 256 + Number.parseInt(hex.slice(i, i + 2), 16)
    return n
  }
  return undefined
}

/** The strings of a `REG_MULTI_SZ` (or a `REG_SZ`), empty ones dropped. */
export function regStrings(value: RegValue | undefined): string[] {
  if (!value || (value.type !== 'REG_MULTI_SZ' && value.type !== 'REG_SZ')) return []
  return value.data.split('\\0').filter((s) => s.trim() !== '')
}

/** One display driver instance, as its class key describes it. */
export interface RegistryDisplayKey {
  /** `0000`, `0001`, … */
  key: string
  MatchingDeviceId?: string
  DriverDesc?: string
  ProviderName?: string
  DriverVersion?: string
  /** Bytes: `HardwareInformation.qwMemorySize` (64-bit). */
  qwMemorySize?: number
  /** Bytes: `HardwareInformation.MemorySize` (32-bit, so 4 GiB at most). */
  memorySize?: number
  VulkanDriverName: string[]
}

/** The driver instances among the parsed keys, with the values the adapter list needs. */
export function registryDisplayKeys(keys: RegKey[]): RegistryDisplayKey[] {
  const out: RegistryDisplayKey[] = []
  for (const key of keys) {
    if (!isDisplayDriverKey(key.path)) continue
    const value = (name: string) => key.values.find((v) => v.name.toLowerCase() === name.toLowerCase())
    const text = (name: string) => {
      const v = value(name)
      return v && v.type === 'REG_SZ' && v.data !== '' ? v.data : undefined
    }
    const entry: RegistryDisplayKey = {
      key: key.path.slice(-4),
      VulkanDriverName: regStrings(value('VulkanDriverName')),
    }
    const fields = {
      MatchingDeviceId: text('MatchingDeviceId'),
      DriverDesc: text('DriverDesc'),
      ProviderName: text('ProviderName'),
      DriverVersion: text('DriverVersion'),
      qwMemorySize: regNumber(value('HardwareInformation.qwMemorySize')),
      memorySize: regNumber(value('HardwareInformation.MemorySize')),
    }
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) Object.assign(entry, { [k]: v })
    out.push(entry)
  }
  return out
}

/** The Vulkan ICD manifests a `HKLM\SOFTWARE\Khronos\Vulkan\Drivers` query lists (value names are paths). */
export function vulkanDriverPaths(keys: RegKey[]): string[] {
  return keys.flatMap((key) => key.values.map((v) => v.name)).filter((name) => /\.json$/i.test(name))
}

const NVIDIA_VENDOR_ID = 0x10de

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * The GPUs the display class key names, in key order, as the PowerShell path's `WindowsAdapter` rows
 * so `mergeGpus` treats them alike. Software adapters (no PCI or Adreno id) are skipped. `nvidiaNames`
 * are the GPUs `nvidia-smi` reported: when it answered, an NVIDIA key is kept only as often as a GPU
 * of that name is there; when it did not, each NVIDIA device id is listed once, like the other vendors.
 */
export function registryGpus(
  displayKeys: RegistryDisplayKey[],
  vulkanDrivers: string[],
  nvidiaNames: string[]
): { adapters: WindowsAdapter[]; icdVendors: Set<string>; warnings: string[] } {
  const icdVendors = new Set<string>()
  for (const manifest of [...vulkanDrivers, ...displayKeys.flatMap((k) => k.VulkanDriverName)]) {
    const vendor = icdVendorOf(manifest)
    if (vendor) icdVendors.add(vendor)
  }
  const candidates: Array<{ adapter: WindowsAdapter; memoryFrom?: 'MemorySize' }> = []
  for (const key of displayKeys) {
    const ids = key.MatchingDeviceId ? parsePnpDeviceId(key.MatchingDeviceId) : undefined
    if (!ids) continue
    let vramTotalMiB: number | undefined
    let memoryFrom: 'MemorySize' | undefined
    if (key.qwMemorySize !== undefined && key.qwMemorySize > 0)
      vramTotalMiB = Math.floor(key.qwMemorySize / 2 ** 20)
    else if (key.memorySize !== undefined && key.memorySize > 0) {
      vramTotalMiB = Math.floor(key.memorySize / 2 ** 20)
      memoryFrom = 'MemorySize'
    }
    candidates.push({
      adapter: {
        name: key.DriverDesc?.trim() || `GPU ${key.MatchingDeviceId}`,
        vendorId: ids.vendorId,
        deviceId: ids.deviceId,
        // The driver key a device instance points at: stable across boots, unique per card.
        pnpDeviceId: `${DISPLAY_CLASS_GUID}\\${key.key}`,
        driverVersion: key.DriverVersion ?? '',
        ...(vramTotalMiB !== undefined ? { vramTotalMiB } : {}),
        vulkanDriver: key.VulkanDriverName.length > 0,
      },
      ...(memoryFrom ? { memoryFrom } : {}),
    })
  }
  // A key with a VRAM figure is the one kept when several describe the same device.
  const ordered = [...candidates].sort(
    (a, b) => Number(b.adapter.vramTotalMiB !== undefined) - Number(a.adapter.vramTotalMiB !== undefined)
  )
  const kept = new Set<(typeof candidates)[number]>()
  const nvidiaLeft = [...nvidiaNames]
  const seen = new Set<string>()
  for (const candidate of ordered) {
    const { adapter } = candidate
    if (adapter.vendorId === NVIDIA_VENDOR_ID && nvidiaNames.length > 0) {
      const i = nvidiaLeft.findIndex((name) => sameName(name, adapter.name))
      if (i < 0) continue
      nvidiaLeft.splice(i, 1)
      kept.add(candidate)
      continue
    }
    const id = `${adapter.vendorId}:${adapter.deviceId}`
    if (seen.has(id)) continue
    seen.add(id)
    kept.add(candidate)
  }
  const adapters: WindowsAdapter[] = []
  const warnings: string[] = []
  for (const candidate of candidates) {
    if (!kept.has(candidate)) continue
    adapters.push(candidate.adapter)
    if (candidate.memoryFrom)
      warnings.push(
        `${candidate.adapter.name}: VRAM read from HardwareInformation.MemorySize, which caps at 4 GiB`
      )
  }
  return { adapters, icdVendors, warnings }
}
