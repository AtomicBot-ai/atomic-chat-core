/**
 * Which Intel NPU generation a machine has, by the CPU model string core's hardware facts carry
 * (change `add-litert-lm-runtime`, design D3). LiteRT-LM NPU files are compiled ahead of time for one
 * generation: `_intel_LNL` (Lunar Lake, Core Ultra 200V) and `_intel_PTL` (Panther Lake, Core Ultra
 * series 3). Meteor Lake (1xx) and Arrow Lake (2xx without V) have an NPU no file targets.
 *
 * Unverified on real hardware (spike S4: no machine); a wrong row only turns a variant into
 * `accelerator-unavailable`, and the table is fixed by a core release.
 */

import type { LiteRtLmNpu } from '../../contracts/index.js'

/** `Core(TM) Ultra [X]<tier> <series><nn><suffix>`, e.g. `Ultra 7 258V`, `Ultra X9 388H`. */
const CORE_ULTRA_RE = /Core(?:\(TM\))?\s+Ultra\s+X?\d+\s+(\d)\d{2}([A-Z]*)\b/i

export function liteRtNpuGeneration(cpuName: string): LiteRtLmNpu | null {
  const match = CORE_ULTRA_RE.exec(cpuName)
  if (!match) return null
  const series = match[1]
  const suffix = (match[2] ?? '').toUpperCase()
  if (series === '2' && suffix === 'V') return 'intel-lnl'
  if (series === '3') return 'intel-ptl'
  return null
}
