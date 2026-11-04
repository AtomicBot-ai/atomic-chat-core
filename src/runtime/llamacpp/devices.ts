/**
 * Parser for `llama-server --list-devices` stdout. Port of the parsing half of
 * `src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/device.rs`; spawning lives in `runtime/`.
 * Pinned by `test/contract/devices.test.ts`.
 *
 * Accepted line shapes (everything after the `Available devices:` header, blank lines skipped):
 *   `Vulkan0: Intel(R) Arc(tm) A750 Graphics (DG2) (8128 MiB, 8128 MiB free)`
 *   `CUDA0: NVIDIA GeForce RTX 4090 (24576 MiB, 24000 MiB free)`
 * The last parenthesised group that looks like `<n> MiB, <n> MiB free` is the memory; the name is
 * everything before it. Unparseable lines are skipped, a missing header is an error, and an empty
 * list is a valid result (the caller treats it as "this tier cannot enumerate a GPU").
 */

import { AtomicCoreError } from '../../contracts/index.js'
import type { DeviceInfo } from '../../contracts/index.js'
import { parseRustI32 } from '../../util/index.js'

export const DEVICES_HEADER = 'Available devices:'

/** `"8128 MiB, 8128 MiB free"` — both halves start with an i32 and mention `MiB`. */
export function isMemoryPattern(content: string): boolean {
  if (!(content.includes('MiB') && content.includes('free') && content.includes(','))) return false
  const parts = content.split(',')
  if (parts.length !== 2) return false
  return parts.every((raw) => {
    const part = raw.trim()
    const first = part.split(/\s+/).find((t) => t !== '')
    return first !== undefined && parseRustI32(first) !== undefined && part.includes('MiB')
  })
}

/** Index of the `(` opening the last memory-looking group, and its content. */
export function findMemoryPattern(text: string): { start: number; content: string } | undefined {
  let last: { start: number; content: string } | undefined
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '(') continue
    const remaining = text.slice(i + 1)
    const close = remaining.indexOf(')')
    if (close < 0) continue
    const content = remaining.slice(0, close)
    if (isMemoryPattern(content)) last = { start: i, content }
  }
  return last
}

/** First whitespace token as i32 (`"7721 MiB free"` → 7721). */
export function parseMemoryValue(memStr: string): number | undefined {
  const first = memStr.split(/\s+/).find((t) => t !== '')
  return first === undefined ? undefined : parseRustI32(first)
}

export function parseDeviceLine(rawLine: string): DeviceInfo | undefined {
  const line = rawLine.trim()
  const colon = line.indexOf(':')
  if (colon < 0) return undefined
  const id = line.slice(0, colon).trim()
  const rest = line.slice(colon + 1).trim()
  const memory = findMemoryPattern(rest)
  if (memory === undefined) return undefined
  const name = rest.slice(0, memory.start).trim()
  const [total, free] = memory.content.split(',').map((p) => parseMemoryValue(p.trim()))
  if (total === undefined || free === undefined) return undefined
  return { id, name, mem: total, free }
}

/**
 * A `--device` value checked against what the build lists: the names it has (llama.cpp matches them
 * case-insensitively, `ggml_backend_dev_by_name`) and `none` are kept in the order given, every other
 * name is dropped. llama-server exits on a name it does not have ("use --list-devices to see a list of
 * available devices"), which is what a value copied from a CUDA build does on a Vulkan or ROCm one.
 * `device` is `''` when nothing is left: llama.cpp then picks its devices itself.
 */
export function validateDeviceList(
  requested: string,
  devices: readonly DeviceInfo[]
): { device: string; dropped: string[] } {
  const known = new Set(devices.map((d) => d.id.toLowerCase()))
  const kept: string[] = []
  const dropped: string[] = []
  for (const raw of String(requested).split(',')) {
    const name = raw.trim()
    if (name === '') continue
    if (name.toLowerCase() === 'none' || known.has(name.toLowerCase())) kept.push(name)
    else dropped.push(name)
  }
  return { device: kept.join(','), dropped }
}

/** Throws `DEVICE_LIST_PARSE_FAILED` (details = the whole output) when the header is missing. */
export function parseDeviceOutput(output: string): DeviceInfo[] {
  const devices: DeviceInfo[] = []
  let foundSection = false
  for (const raw of output.split(/\r?\n/)) {
    if (raw.trim() === DEVICES_HEADER) {
      foundSection = true
      continue
    }
    if (!foundSection || raw.trim() === '') continue
    const device = parseDeviceLine(raw)
    if (device !== undefined) devices.push(device)
  }
  if (!foundSection) {
    throw new AtomicCoreError(
      'DEVICE_LIST_PARSE_FAILED',
      "Could not find 'Available devices:' section in the backend output.",
      output
    )
  }
  return devices
}
