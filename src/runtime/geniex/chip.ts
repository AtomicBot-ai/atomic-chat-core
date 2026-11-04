/**
 * Where the `geniex` provider registers, and which Snapdragon chip the machine has (openspec change
 * `add-geniex-runtime`, task 4.3, design D3): Windows arm64 whose processor string names a Snapdragon
 * X of either generation. The AI Hub bundles are compiled per Hexagon generation, not per SKU, and
 * conf spells the generations `x-elite` (Hexagon v73: X Elite `X1E…`, X Plus `X1P…`, X `X1-…`) and
 * `x2-elite` (v81: X2 Elite `X2E…`, X2 Plus `X2P…`) — AI Hub itself points the X Plus at the X Elite
 * zip. Other arm64 Windows machines (virtual machines, 8cx: Hexagon v69, which the SDK has no HTP
 * library for) keep the provider off.
 *
 * The same table shape as LiteRT-LM's Intel NPU generations (`litert-lm/npu.ts`). Verified on an X2
 * Elite (rulings/core.md, spike S1); the first generation is read off the part numbers only.
 */

import type { GeniexChip } from '../../contracts/index.js'

/**
 * The part numbers as a bare word, not a suffix: `X1E80100`, `X1E78100` (X Elite), `X1P64100` (X Plus),
 * `X1-26-100` (X), `X2E88100` (X2 Elite), `X2P…` (X2 Plus).
 */
const PART_RE = /(?:^|[^A-Za-z0-9])(X1E|X1P|X1(?=-\d)|X2E|X2P)\d*(?![A-Za-z])/

export function geniexChip(cpuName: string): GeniexChip | null {
  const part = PART_RE.exec(cpuName)?.[1]
  if (!part) return null
  return part.startsWith('X1') ? 'x-elite' : 'x2-elite'
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
      reason: `GenieX runs on Snapdragon X (X Elite, X Plus, X, X2 Elite, X2 Plus) only; this processor is "${host.cpuName}".`,
    }
  return { platform: 'win-arm64', chip }
}
