/**
 * Whether this machine has an NPU (openspec change `add-foundry-local`, task 6.5). Windows ML offers
 * the OpenVINO accelerator on Intel machines without one (spike rulings S2), so "OpenVINO found" does
 * not mean "NPU here": the device list does. NPUs register as PnP class `ComputeAccelerator` (Intel AI
 * Boost, Qualcomm Hexagon, AMD's IPU). Off Windows there is no NPU this core runs variants on.
 */

import { PROBE_POWERSHELL_TIMEOUT_MS } from './probe-common.js'
import type { ProbeDeps } from './probe-common.js'

export interface NpuPresence {
  /** `null`: Windows could not be asked; callers then go by the accelerators the library offers. */
  present: boolean | null
  devices: string[]
}

const NPU_QUERY =
  "Get-CimInstance Win32_PnPEntity -Filter \"PNPClass='ComputeAccelerator'\" | Where-Object { $_.Status -eq 'OK' } | ForEach-Object { $_.Name }"

export function parseNpuDevices(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

export async function probeNpu(deps: Pick<ProbeDeps, 'platform' | 'run'>): Promise<NpuPresence> {
  if (deps.platform !== 'win32') return { present: false, devices: [] }
  try {
    const result = await deps.run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', NPU_QUERY],
      PROBE_POWERSHELL_TIMEOUT_MS
    )
    if (result.code !== 0) return { present: null, devices: [] }
    const devices = parseNpuDevices(result.stdout)
    return { present: devices.length > 0, devices }
  } catch {
    return { present: null, devices: [] }
  }
}
