/**
 * Where the `geniex` provider registers, and which Snapdragon chip the machine has (openspec change
 * `add-geniex-runtime`, task 4.3, design D3): Windows arm64 whose processor string names a Snapdragon
 * X Elite (`X1E…`) or X2 Elite (`X2E…`). Other arm64 Windows machines (virtual machines, Snapdragon X
 * Plus, 8cx) have no HTP GenieX's signed bundle targets, so the provider stays off there. The chip
 * matters for AI Hub bundles, which are compiled per SoC.
 *
 * The same table shape as LiteRT-LM's Intel NPU generations (`litert-lm/npu.ts`); unverified on real
 * hardware until the spike (rulings/core.md), and fixed by a core release when wrong.
 */

import type { GeniexChip } from '../../contracts/index.js'

/** The part numbers: `X1E80100`, `X1E78100` (X Elite); `X2E…` (X2 Elite). A bare word, not a suffix. */
const PART_RE = /(?:^|[^A-Za-z0-9])(X1E|X2E)\d*(?![A-Za-z])/

export function geniexChip(cpuName: string): GeniexChip | null {
  const match = PART_RE.exec(cpuName)
  if (!match) return null
  return match[1] === 'X1E' ? 'x-elite' : 'x2-elite'
}

export interface GeniexHostFacts {
  platform: NodeJS.Platform
  arch: string
  /** `Win32_Processor.Name` on Windows, as the hardware probe reports it. */
  cpuName: string
}

/** Which SDK zip this host runs and which chip it has, or why none (`EngineHostPlatform` for engine-builds). */
export type GeniexHostPlatform =
  { platform: 'win-arm64'; chip: GeniexChip } | { platform: null; reason: string }

export function geniexHostPlatform(host: GeniexHostFacts): GeniexHostPlatform {
  if (host.platform !== 'win32' || host.arch !== 'arm64')
    return { platform: null, reason: `GenieX runs on Windows arm64 only, not ${host.platform} ${host.arch}.` }
  const chip = geniexChip(host.cpuName)
  if (!chip)
    return {
      platform: null,
      reason: `GenieX runs on Snapdragon X Elite and X2 Elite only; this processor is "${host.cpuName}".`,
    }
  return { platform: 'win-arm64', chip }
}
