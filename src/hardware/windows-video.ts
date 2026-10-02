/**
 * Windows GPUs, CPU and OS from one PowerShell run: `Win32_VideoController` for the adapters, the
 * display class registry for the driver's own VRAM figure (`HardwareInformation.qwMemorySize`, which
 * `AdapterRAM` cannot hold above 4 GiB) and its Vulkan ICD, `Win32_Processor` / `Win32_OperatingSystem`
 * for names and cores, `vulkan-1.dll` + the Khronos driver registrations for the loader, and
 * `IsProcessorFeaturePresent` for the CPU flags. One process, one JSON document, because PowerShell
 * takes seconds to start and five runs would take five times as long.
 *
 * Pure: the script text, its arguments, and the parse of what comes back. `probe-windows.ts` runs it.
 */

import { icdVendorOf } from './vulkan.js'

const DISPLAY_CLASS_KEY =
  'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'

/**
 * One line, `;`-separated, no double quotes (the C# attribute builds its quotes from `[char]34`): what
 * `-Command` receives has been through Node's Windows argument quoting and PowerShell's own parser,
 * and a script that never needs escaping cannot be mangled by either. Every list is wrapped in `@()`
 * and the parser still accepts a bare object, because PowerShell 5.1 collapses single-element
 * collections on the way to JSON. `Add-Type` fails in Constrained Language Mode; `pf` is then `null`.
 */
export const WINDOWS_PROBE_SCRIPT: string = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  '$video = @(Get-CimInstance Win32_VideoController | Select-Object Name, AdapterRAM, PNPDeviceID, DriverVersion)',
  `$classKeys = @(Get-ChildItem '${DISPLAY_CLASS_KEY}' | Where-Object { $_.PSChildName -match '^\\d{4}$' } | ForEach-Object { $p = Get-ItemProperty $_.PSPath; [pscustomobject]@{ key = $_.PSChildName; MatchingDeviceId = $p.MatchingDeviceId; DriverDesc = $p.DriverDesc; qwMemorySize = $p.'HardwareInformation.qwMemorySize'; VulkanDriverName = @($p.VulkanDriverName | Where-Object { $_ }) } })`,
  '$cpu = @(Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores)',
  '$os = Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber',
  "$drivers = @((Get-Item 'HKLM:\\SOFTWARE\\Khronos\\Vulkan\\Drivers').Property | Where-Object { $_ })",
  "$vulkan = @{ dll = [bool](Test-Path (Join-Path $env:SystemRoot 'System32\\vulkan-1.dll')); drivers = $drivers }",
  '$pf = $null',
  "try { Add-Type -Namespace AtomicProbe -Name Native -MemberDefinition ('[DllImport(' + [char]34 + 'kernel32.dll' + [char]34 + ')] public static extern bool IsProcessorFeaturePresent(int f);'); $pf = @{}; foreach ($f in 3,6,10,13,36,37,38,39,40,41) { $pf[[string]$f] = [bool][AtomicProbe.Native]::IsProcessorFeaturePresent($f) } } catch { $pf = $null }",
  '$build = [Environment]::OSVersion.Version.Build',
  '[pscustomobject]@{ video = $video; classKeys = $classKeys; cpu = $cpu; os = $os; vulkan = $vulkan; pf = $pf; build = $build } | ConvertTo-Json -Depth 5 -Compress',
].join('; ')

export function windowsProbeArgs(): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_PROBE_SCRIPT]
}

export interface WindowsVideoController {
  Name?: string
  /** Bytes, a 32-bit field: 4 GiB minus one at most. */
  AdapterRAM?: number
  /** `PCI\VEN_10DE&DEV_2684&SUBSYS_…&REV_A1\4&…`, or `ROOT\…` / `SWD\…` for software adapters. */
  PNPDeviceID?: string
  DriverVersion?: string
}

export interface WindowsDisplayClassKey {
  /** `0000`, `0001`, … */
  key: string
  /** `pci\ven_10de&dev_2684` (lower case, no subsystem) — how the key is matched to an adapter. */
  MatchingDeviceId?: string
  DriverDesc?: string
  /** `HardwareInformation.qwMemorySize`, bytes, 64-bit. */
  qwMemorySize?: number
  /** The ICD manifests this driver registered, absolute paths. */
  VulkanDriverName: string[]
}

export interface WindowsProbe {
  video: WindowsVideoController[]
  classKeys: WindowsDisplayClassKey[]
  cpu: Array<{ Name?: string; NumberOfCores?: number }>
  os: { Caption?: string; Version?: string; BuildNumber?: string } | undefined
  vulkan: { dll: boolean; drivers: string[] }
  /** `IsProcessorFeaturePresent` by feature number, or `null` when the P/Invoke could not be compiled. */
  pf: Record<string, boolean> | null
  build: number
}

type Json = Record<string, unknown>

function asArray(value: unknown): unknown[] {
  if (value === null || value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function asObject(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value)
  return undefined
}

/** Parse the script's JSON. Tolerates a UTF-8 BOM and single-element collapse; throws on anything that is not the document. */
export function parseWindowsProbe(json: string): WindowsProbe {
  const root = asObject(JSON.parse(json.replace(/^\uFEFF/, '')))
  if (!root) throw new Error('the PowerShell probe did not answer with a JSON object')
  const video: WindowsVideoController[] = []
  for (const entry of asArray(root['video'])) {
    const o = asObject(entry)
    if (!o) continue
    video.push(
      compact<WindowsVideoController>({
        Name: asString(o['Name']),
        AdapterRAM: asNumber(o['AdapterRAM']),
        PNPDeviceID: asString(o['PNPDeviceID']),
        DriverVersion: asString(o['DriverVersion']),
      })
    )
  }
  const classKeys: WindowsDisplayClassKey[] = []
  for (const entry of asArray(root['classKeys'])) {
    const o = asObject(entry)
    const key = o ? asString(o['key']) : undefined
    if (!o || key === undefined) continue
    classKeys.push({
      key,
      ...compact<Pick<WindowsDisplayClassKey, 'MatchingDeviceId' | 'DriverDesc' | 'qwMemorySize'>>({
        MatchingDeviceId: asString(o['MatchingDeviceId']),
        DriverDesc: asString(o['DriverDesc']),
        qwMemorySize: asNumber(o['qwMemorySize']),
      }),
      VulkanDriverName: asArray(o['VulkanDriverName']).flatMap((v) => (typeof v === 'string' ? [v] : [])),
    })
  }
  const cpu: WindowsProbe['cpu'] = []
  for (const entry of asArray(root['cpu'])) {
    const o = asObject(entry)
    if (o)
      cpu.push(
        compact<WindowsProbe['cpu'][number]>({
          Name: asString(o['Name']),
          NumberOfCores: asNumber(o['NumberOfCores']),
        })
      )
  }
  const osObject = asObject(root['os'])
  const os = osObject
    ? compact<NonNullable<WindowsProbe['os']>>({
        Caption: asString(osObject['Caption']),
        Version: asString(osObject['Version']),
        BuildNumber: asString(osObject['BuildNumber']),
      })
    : undefined
  const vulkanObject = asObject(root['vulkan'])
  const vulkan = {
    dll: vulkanObject?.['dll'] === true,
    drivers: asArray(vulkanObject?.['drivers']).flatMap((v) => (typeof v === 'string' ? [v] : [])),
  }
  const pfObject = asObject(root['pf'])
  const pf = pfObject ? Object.fromEntries(Object.entries(pfObject).map(([k, v]) => [k, v === true])) : null
  const build = asNumber(root['build']) ?? asNumber(os?.BuildNumber) ?? 0
  return { video, classKeys, cpu, os, vulkan, pf, build }
}

/** Drop the `undefined` entries, so an absent field is absent (`exactOptionalPropertyTypes`). */
function compact<T extends object>(value: { [K in keyof T]: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

const QUALCOMM_VENDOR_ID = 0x5143

/**
 * `PCI\VEN_10DE&DEV_2684&…` → the two ids. Snapdragon's Adreno is not on PCI: its instance id is
 * `ACPI\QCOM0C36\…` (or `ACPI\VEN_QCOM&DEV_0C36…`), read as Qualcomm's Vulkan vendor id and the
 * ACPI device number. `undefined` for anything else.
 */
export function parsePnpDeviceId(id: string): { vendorId: number; deviceId: number } | undefined {
  const m = /PCI\\VEN_([0-9A-F]{4})&DEV_([0-9A-F]{4})/i.exec(id)
  if (m) return { vendorId: Number.parseInt(m[1] ?? '', 16), deviceId: Number.parseInt(m[2] ?? '', 16) }
  const qcomDevice = /ACPI\\(?:VEN_)?QCOM(?:&DEV_)?([0-9A-F]{4})/i.exec(id)?.[1]
  if (qcomDevice) return { vendorId: QUALCOMM_VENDOR_ID, deviceId: Number.parseInt(qcomDevice, 16) }
  return undefined
}

/** The display class keys registered for an adapter: PCI keys by `ven_xxxx&dev_xxxx`, Adreno by `qcom` + device. */
function classKeysFor(
  classKeys: WindowsDisplayClassKey[],
  ids: { vendorId: number; deviceId: number }
): WindowsDisplayClassKey[] {
  const dev = hex4(ids.deviceId)
  if (ids.vendorId === QUALCOMM_VENDOR_ID) {
    return classKeys.filter((key) => {
      const id = (key.MatchingDeviceId ?? '').toLowerCase()
      return id.includes('qcom') && id.includes(dev)
    })
  }
  const needle = `ven_${hex4(ids.vendorId)}&dev_${dev}`
  return classKeys.filter((key) => (key.MatchingDeviceId ?? '').toLowerCase().includes(needle))
}

/** A PCI display adapter as the probe saw it, before merging with nvidia-smi. */
export interface WindowsAdapter {
  name: string
  vendorId: number
  deviceId: number
  /** The PNP instance id, the stable opaque `uuid` of a non-NVIDIA GPU. */
  pnpDeviceId: string
  /** The OS driver string (`32.0.15.8142` for an NVIDIA WDDM driver). */
  driverVersion: string
  /** MiB; absent when neither the class key nor `AdapterRAM` had a figure. */
  vramTotalMiB?: number
  /** The display class key registered a Vulkan ICD for this adapter. */
  vulkanDriver: boolean
}

/**
 * The PCI GPUs of the machine, plus Snapdragon's ACPI-enumerated Adreno. Software adapters (`ROOT\BasicDisplay`, the `SWD\` RDP mirror) are not
 * GPUs and are skipped. VRAM comes from the class key matched by vendor and device id — `AdapterRAM`
 * is a 32-bit field that reports 4 GiB for every larger card, so falling back to it is warned about.
 */
export function windowsGpus(probe: WindowsProbe): {
  adapters: WindowsAdapter[]
  icdVendors: Set<string>
  warnings: string[]
} {
  const adapters: WindowsAdapter[] = []
  const warnings: string[] = []
  const icdVendors = new Set<string>()
  for (const driver of probe.vulkan.drivers) {
    const vendor = icdVendorOf(driver)
    if (vendor) icdVendors.add(vendor)
  }
  for (const key of probe.classKeys)
    for (const manifest of key.VulkanDriverName) {
      const vendor = icdVendorOf(manifest)
      if (vendor) icdVendors.add(vendor)
    }
  for (const controller of probe.video) {
    const pnp = controller.PNPDeviceID
    if (!pnp || /^(ROOT|SWD)\\/i.test(pnp)) continue
    const ids = parsePnpDeviceId(pnp)
    if (!ids) continue
    const name = controller.Name?.trim() || `GPU ${pnp}`
    const matching = classKeysFor(probe.classKeys, ids)
    const classKey = matching.find((key) => key.qwMemorySize !== undefined) ?? matching[0]
    let vramTotalMiB: number | undefined
    if (classKey?.qwMemorySize !== undefined && classKey.qwMemorySize > 0)
      vramTotalMiB = Math.floor(classKey.qwMemorySize / 2 ** 20)
    else if (controller.AdapterRAM !== undefined && controller.AdapterRAM > 0) {
      vramTotalMiB = Math.floor(controller.AdapterRAM / 2 ** 20)
      warnings.push(`${name}: VRAM read from Win32_VideoController.AdapterRAM, which caps at 4 GiB`)
    }
    adapters.push({
      name,
      vendorId: ids.vendorId,
      deviceId: ids.deviceId,
      pnpDeviceId: pnp,
      driverVersion: controller.DriverVersion ?? '',
      ...(vramTotalMiB !== undefined ? { vramTotalMiB } : {}),
      vulkanDriver: matching.some((key) => key.VulkanDriverName.length > 0),
    })
  }
  return { adapters, icdVendors, warnings }
}

function hex4(value: number): string {
  return value.toString(16).padStart(4, '0')
}

/** Physical cores across sockets; `undefined` when CIM did not answer. */
export function coreCount(probe: WindowsProbe): number | undefined {
  let total = 0
  for (const cpu of probe.cpu)
    if (cpu.NumberOfCores !== undefined && cpu.NumberOfCores > 0) total += cpu.NumberOfCores
  return total > 0 ? total : undefined
}

/** `Microsoft Windows 11 Pro`, as CIM spells it; `undefined` when it did not answer. */
export function osName(probe: WindowsProbe): string | undefined {
  const caption = probe.os?.Caption?.trim()
  return caption ? caption : undefined
}
